import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CandidateJudgmentSchema,
  AnonymousMapSchema,
  ContestantsConfigSchema,
  IdentitySchema,
  JudgesConfigSchema,
  LeaderboardSchema,
  ManifestSchema,
  GenerationAwardsSchema,
  RunSchema,
  ValidationSchema,
  readJsonWithSchema,
  readYamlWithSchema,
  type Leaderboard,
} from "../schemas/index.js";
import {
  aggregateScores,
  serializeLeaderboard,
  type ScoreAwardsInput,
  type ScoreCandidateInput,
  type ScoreJudgeInput,
} from "./aggregator.js";
import { regularFileExists, writeTextAtomically } from "../contestants/support.js";

export interface AggregateGenerationArtifactsOptions {
  readonly generationPath: string;
  readonly generatedAt?: string;
}

function contestantStatus(input: {
  readonly run: ReturnType<typeof RunSchema.parse>;
  readonly validation: ReturnType<typeof ValidationSchema.parse>;
  readonly screenshotExists: boolean;
}): ScoreCandidateInput["status"] {
  if (input.run.status === "timeout") return "timeout";
  if (input.validation.status === "render_failed") return "render_failed";
  if (
    input.run.status === "failed" ||
    input.run.status === "uncertain" ||
    input.run.status === "missing_submission"
  ) {
    return "execution_failed";
  }
  if (input.run.status !== "succeeded") return "execution_failed";
  if (input.validation.status === "invalid") return "invalid";
  return input.screenshotExists ? "valid" : "render_failed";
}

async function readOptionalJson(path: string): Promise<unknown | null> {
  if (!(await regularFileExists(path))) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readJudgeArtifacts(
  generationPath: string,
  judgeId: string,
): Promise<{ readonly judgments: unknown[]; readonly awards: ScoreAwardsInput[] }> {
  const judgePath = join(generationPath, "judging", judgeId);
  let entries;
  try {
    entries = await readdir(judgePath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { judgments: [], awards: [] };
    }
    throw error;
  }
  const judgments: unknown[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (
      entry.name === "awards.json" ||
      entry.name === "judgment-summary.json" ||
      entry.name === "contact-sheet-order.json" ||
      entry.name === "assessment-order.json" ||
      entry.name === "task-timings.json"
    ) {
      continue;
    }
    const raw = await readOptionalJson(join(judgePath, entry.name));
    if (raw === null) continue;
    const parsed = CandidateJudgmentSchema.safeParse(raw);
    if (!parsed.success || parsed.data.judgeId !== judgeId) continue;
    if (parsed.data.anonymousCandidateId !== entry.name.slice(0, -5)) continue;
    judgments.push(parsed.data);
  }
  const awards = [] as ScoreAwardsInput[];
  const awardsPath = join(judgePath, "awards.json");
  const rawAwards = await readOptionalJson(awardsPath);
  if (rawAwards !== null) {
    const parsedAwards = GenerationAwardsSchema.safeParse(rawAwards);
    if (parsedAwards.success && parsedAwards.data.judgeId === judgeId) {
      awards.push(parsedAwards.data);
    }
  }
  return { judgments, awards };
}

export async function aggregateGenerationArtifacts(
  options: AggregateGenerationArtifactsOptions,
): Promise<Leaderboard> {
  const generationPath = options.generationPath;
  const manifest = await readJsonWithSchema(
    join(generationPath, "manifest.json"),
    ManifestSchema,
  );
  const contestantsConfig = await readYamlWithSchema(
    join(generationPath, "config/contestants.yaml"),
    ContestantsConfigSchema,
  );
  const judgesConfig = await readYamlWithSchema(
    join(generationPath, "config/judges.yaml"),
    JudgesConfigSchema,
  );
  const anonymousMap = await readJsonWithSchema(
    join(generationPath, "judging/anonymous-map.json"),
    AnonymousMapSchema,
  );
  if (anonymousMap.generationId !== manifest.generationId) {
    throw new Error("anonymous map generation does not match the manifest");
  }
  const manifestContestantIds = new Set(manifest.contestantIds);
  if (
    anonymousMap.entries.length !== manifestContestantIds.size ||
    anonymousMap.entries.some((entry) => !manifestContestantIds.has(entry.contestantId))
  ) {
    throw new Error("anonymous map contestant set does not match the manifest");
  }
  const anonymousByContestant = new Map(
    anonymousMap.entries.map((entry) => [
      entry.contestantId,
      entry.anonymousCandidateId,
    ]),
  );
  const contestantInputs: ScoreCandidateInput[] = [];
  for (const contestantId of manifest.contestantIds) {
    const contestant = contestantsConfig.contestants.find(
      (entry) => entry.id === contestantId,
    );
    if (contestant === undefined) {
      throw new Error(
        `manifest contestant is missing from the config snapshot: ${contestantId}`,
      );
    }
    const contestantPath = join(generationPath, "contestants", contestantId);
    const identity = await readJsonWithSchema(
      join(contestantPath, "identity.json"),
      IdentitySchema,
    );
    if (identity.contestantId !== contestantId) {
      throw new Error(
        `identity contestantId does not match its manifest directory: ${contestantId}`,
      );
    }
    const mappedAnonymousCandidateId = anonymousByContestant.get(contestantId);
    if (
      mappedAnonymousCandidateId === undefined ||
      identity.anonymousCandidateId !== mappedAnonymousCandidateId
    ) {
      throw new Error(
        `anonymous map does not match identity for contestant ${contestantId}`,
      );
    }
    const run = await readJsonWithSchema(join(contestantPath, "run.json"), RunSchema);
    const validationValue = await readOptionalJson(
      join(contestantPath, "validation.json"),
    );
    const validation = ValidationSchema.parse(
      validationValue ?? {
        schemaVersion: 1,
        status: "invalid",
        submissionSha256: null,
        sanitisedSha256: null,
        submissionBytes: 0,
        staticChecks: [],
        renderChecks: [],
        errors: ["validation artifact is missing"],
        warnings: [],
      },
    );
    const screenshotExists = await regularFileExists(
      join(contestantPath, "screenshot.png"),
    );
    const status = contestantStatus({ run, validation, screenshotExists });
    const failure = run.error ?? validation.errors[0] ?? validation.warnings[0] ?? null;
    contestantInputs.push({
      contestantId,
      anonymousCandidateId: mappedAnonymousCandidateId,
      displayName: identity.displayName,
      harnessName: identity.harness.name,
      modelName: identity.model.name,
      provider: identity.model.provider,
      modelFamily: identity.model.family ?? null,
      status,
      screenshotPath:
        status === "valid" ? `contestants/${contestantId}/screenshot.png` : null,
      failure,
    });
  }

  const judges: ScoreJudgeInput[] = [];
  const judgments: unknown[] = [];
  const awards: ScoreAwardsInput[] = [];
  for (const judgeId of manifest.judgeIds) {
    const judge = judgesConfig.judges.find((entry) => entry.id === judgeId);
    if (judge === undefined) {
      throw new Error(`manifest judge is missing from the config snapshot: ${judgeId}`);
    }
    judges.push({
      id: judgeId,
      provider: judge.model.provider,
      modelFamily: judge.model.family ?? null,
    });
    const artifacts = await readJudgeArtifacts(generationPath, judgeId);
    judgments.push(...artifacts.judgments);
    awards.push(...artifacts.awards);
  }

  return aggregateScores({
    seasonId: manifest.seasonId,
    generationId: manifest.generationId,
    generatedAt:
      options.generatedAt ?? manifest.completedAt ?? new Date().toISOString(),
    expectedJudgeCount: manifest.judgeIds.length,
    judges,
    candidates: contestantInputs,
    judgments,
    awards,
  });
}

export async function writeGenerationLeaderboard(
  generationPath: string,
  leaderboard: Leaderboard,
): Promise<void> {
  const validated = LeaderboardSchema.parse(leaderboard);
  await writeTextAtomically(
    join(generationPath, "leaderboard.json"),
    serializeLeaderboard(validated),
  );
}
