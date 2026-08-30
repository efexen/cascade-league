import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  allocateGenerationId,
  profileJsonBytes,
  seasonDirectoryName,
} from "../artifacts/generation.js";
import { loadSeasonDefinition } from "../challenge/index.js";
import { resolveProfile, type ResolvedProfile } from "../config/profiles.js";
import { buildRunPlan } from "../planning/index.js";
import {
  runRepositoryPreflight,
  type VerificationIssue,
  type VerificationReport,
} from "../preflight/index.js";
import {
  ManifestSchema,
  RunPlanSchema,
  readJsonWithSchema,
  type RunPlan,
} from "../schemas/index.js";

export interface PlanGenerationOptions {
  readonly repositoryRoot: string;
  readonly seasonId: string;
  readonly profileId: string;
  readonly generationsRoot?: string;
  readonly acceptPromptOnlyOneShot?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface PlanGenerationOutcome {
  readonly report: VerificationReport;
  readonly plan: RunPlan | null;
  readonly promptOnlyRefusal: readonly string[];
}

async function sha256Text(text: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(text))
    .digest("hex");
}

async function seasonDirectoryExists(
  repositoryRoot: string,
  seasonId: string,
): Promise<boolean> {
  try {
    const status = await stat(
      join(repositoryRoot, "challenge", seasonDirectoryName(seasonId)),
    );
    return status.isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * The season-continuity validation that `create-generation` performs for the
 * next generation: the season directory must exist, and for generation two
 * onward the previous generation must exist, be completed, and carry a
 * manifest roster that exactly matches the enabled roster.
 */
async function seasonContinuityIssues(
  repositoryRoot: string,
  seasonId: string,
  generationId: string,
  profile: ResolvedProfile,
  generationsRoot: string,
): Promise<VerificationIssue[]> {
  const issues: VerificationIssue[] = [];
  if (!(await seasonDirectoryExists(repositoryRoot, seasonId))) {
    issues.push({
      code: "season_inputs",
      severity: "error",
      message: `challenge/season directory for season ${seasonId} is missing`,
    });
    return issues;
  }
  try {
    const definition = await loadSeasonDefinition(
      join(repositoryRoot, "challenge", seasonDirectoryName(seasonId)),
    );
    if (definition.config.seasonId !== seasonId) {
      issues.push({
        code: "season_inputs",
        severity: "error",
        message: "requested seasonId does not match challenge configuration",
      });
    }
  } catch (error) {
    issues.push({
      code: "season_inputs",
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    return issues;
  }

  const numericGenerationId = Number.parseInt(generationId, 10);
  if (numericGenerationId <= 1) return issues;
  const previousGenerationId = (numericGenerationId - 1).toString().padStart(4, "0");
  const previousGenerationPath = join(generationsRoot, previousGenerationId);
  let manifest;
  try {
    manifest = await readJsonWithSchema(
      join(previousGenerationPath, "manifest.json"),
      ManifestSchema,
    );
  } catch (error) {
    issues.push({
      code: "season_continuity",
      severity: "error",
      message: `previous generation ${previousGenerationId} is required before creating ${generationId}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return issues;
  }
  if (
    manifest.seasonId !== seasonId ||
    manifest.generationId !== previousGenerationId
  ) {
    issues.push({
      code: "season_continuity",
      severity: "error",
      message: "previous manifest does not match the requested season or generation",
    });
    return issues;
  }
  if (manifest.status !== "completed" || manifest.completedAt === null) {
    issues.push({
      code: "season_continuity",
      severity: "error",
      message: `previous generation ${previousGenerationId} is not completed`,
    });
    return issues;
  }
  const enabledContestantIds = profile.contestants.contestants
    .filter((contestant) => contestant.enabled)
    .map((contestant) => contestant.id);
  if (
    enabledContestantIds.length !== manifest.contestantIds.length ||
    enabledContestantIds.some(
      (contestantId, index) => contestantId !== manifest.contestantIds[index],
    )
  ) {
    issues.push({
      code: "season_continuity",
      severity: "error",
      message:
        "enabled contestant roster must exactly match the previous manifest roster",
    });
  }
  return issues;
}

/**
 * Pure, no-write, no-model-call preview of the next generation. Runs the
 * shared preflight plus the season-continuity validation `create-generation`
 * performs, so plan failures predict create failures.
 */
export async function planGeneration(
  options: PlanGenerationOptions,
): Promise<PlanGenerationOutcome> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const report = await runRepositoryPreflight(repositoryRoot, options.profileId, {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    seasonId: options.seasonId,
  });
  const issues = [...report.issues];

  let profile: ResolvedProfile;
  try {
    profile = await resolveProfile(repositoryRoot, options.profileId);
  } catch {
    // The preflight already recorded the profile_resolution error.
    return { report: { ok: false, issues }, plan: null, promptOnlyRefusal: [] };
  }
  const generationsRoot = resolve(
    options.generationsRoot ?? join(repositoryRoot, "generations"),
  );
  const generationId = await allocateGenerationId(generationsRoot);
  issues.push(
    ...(await seasonContinuityIssues(
      repositoryRoot,
      options.seasonId,
      generationId,
      profile,
      generationsRoot,
    )),
  );

  const ok = issues.every((entry) => entry.severity !== "error");
  if (!ok) {
    return {
      report: { ok: false, issues },
      plan: null,
      promptOnlyRefusal: [],
    };
  }

  const promptOnlyContestants = profile.contestants.contestants
    .filter(
      (contestant) =>
        contestant.enabled &&
        contestant.harness.adapter === "command" &&
        contestant.execution?.oneShotEnforcement === "prompt_only",
    )
    .map((contestant) => contestant.id);
  if (promptOnlyContestants.length > 0 && options.acceptPromptOnlyOneShot !== true) {
    return {
      report: { ok: true, issues },
      plan: null,
      promptOnlyRefusal: promptOnlyContestants,
    };
  }

  const plan = RunPlanSchema.parse(
    buildRunPlan({
      profile,
      seasonId: options.seasonId,
      generationId,
      previousGenerationId:
        Number.parseInt(generationId, 10) > 1
          ? (Number.parseInt(generationId, 10) - 1).toString().padStart(4, "0")
          : null,
      configSnapshotHashes: {
        "config/contestants.yaml": await sha256Text(profile.contestantsPath),
        "config/judges.yaml": await sha256Text(profile.judgesPath),
        "config/profile.json": createHash("sha256")
          .update(profileJsonBytes(profile))
          .digest("hex"),
      },
      promptOnlyOneShotAccepted: options.acceptPromptOnlyOneShot === true,
    }),
  );
  return {
    report: { ok: true, issues },
    plan,
    promptOnlyRefusal: [],
  };
}

export function formatRunPlan(plan: RunPlan): string {
  const lines: string[] = [];
  lines.push(
    `plan for season ${plan.seasonId}, generation ${plan.generationId}, profile "${plan.profileId}"`,
  );
  lines.push(
    `external model calls required: ${plan.externalModelCallsRequired ? "yes" : "no"}`,
  );
  lines.push(`contestant calls: ${String(plan.callCounts.contestantCalls)}`);
  lines.push(
    `candidate-judging calls: ${String(plan.callCounts.candidateJudgingCalls)}`,
  );
  lines.push(`awards calls: ${String(plan.callCounts.awardsCalls)}`);
  lines.push(`maximum total calls: ${String(plan.callCounts.maximumTotalCalls)}`);
  lines.push("enabled contestants:");
  for (const entry of plan.contestants) {
    lines.push(`  - ${entry.id} (${entry.displayName})`);
  }
  lines.push("enabled judges:");
  for (const entry of plan.judges) {
    lines.push(`  - ${entry.id} (${entry.displayName})`);
  }
  lines.push("contestant ceilings (timeoutMs / maximumTotalTokens):");
  for (const ceiling of plan.ceilings.contestants) {
    lines.push(
      `  - ${ceiling.id} timeoutMs=${String(ceiling.timeoutMs)} maximumTotalTokens=${String(ceiling.maximumTotalTokens)}`,
    );
  }
  lines.push("judge ceilings (timeoutMs / maximumOutputTokens):");
  for (const ceiling of plan.ceilings.judges) {
    lines.push(
      `  - ${ceiling.id} timeoutMs=${String(ceiling.timeoutMs)} maximumOutputTokens=${String(ceiling.maximumOutputTokens)}`,
    );
  }
  const groupNames = Object.keys(plan.resourceGroups);
  if (groupNames.length === 0) {
    lines.push("resource groups: none declared");
  } else {
    lines.push("resource groups (maximumConcurrency / minimumStartIntervalMs):");
    for (const name of groupNames) {
      const group = plan.resourceGroups[name]!;
      lines.push(
        `  - ${name} maximumConcurrency=${String(group.maximumConcurrency)} minimumStartIntervalMs=${String(group.minimumStartIntervalMs)} entries=${group.entryIds.join(",")}`,
      );
    }
  }
  if (plan.usageReportingUnsupported.length === 0) {
    lines.push(
      "usage/cost reporting: every enabled command entry declares {usageOutputPath}",
    );
  } else {
    lines.push(
      `usage/cost reporting unsupported (argv lacks {usageOutputPath}): ${plan.usageReportingUnsupported.join(", ")}`,
    );
  }
  if (plan.promptOnlyOneShot.length === 0) {
    lines.push("prompt-only one-shot contestants: none");
  } else {
    lines.push(
      `prompt-only one-shot contestants: ${plan.promptOnlyOneShot.join(", ")}${plan.promptOnlyOneShotAccepted ? " (accepted)" : ""}`,
    );
  }
  lines.push("run-plan.json:");
  lines.push(JSON.stringify(plan, null, 2));
  return `${lines.join("\n")}\n`;
}
