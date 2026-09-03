import {
  appendFile,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { createGeneration } from "../../src/artifacts/generation.js";
import {
  CommandContestantAdapter,
  FixtureContestantAdapter,
  type ContestantAdapter,
} from "../../src/contestants/index.js";
import {
  buildAnonymousContactSheet,
  CommandJudgeAdapter,
  FixtureJudgeAdapter,
} from "../../src/judging/index.js";
import { runWaveB } from "../../src/orchestration/wave-b.js";
import {
  ExecutionMetadataFileSchema,
  emptyExecutionMetadata,
} from "../../src/contestants/support.js";
import {
  CandidateJudgmentSchema,
  ContactSheetOrderSchema,
  GenerationAwardsSchema,
  IdentitySchema,
  JudgeAssessmentOrderSchema,
  JudgeSummarySchema,
  JudgeTaskTimingsSchema,
  ManifestSchema,
  RunSchema,
  ValidationSchema,
} from "../../src/schemas/index.js";
import type {
  JudgeAdapter,
  JudgeAwardsInput,
  JudgeCandidateInput,
} from "../../src/judging/index.js";
import type { JudgeConfig } from "../../src/schemas/index.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

async function listFilesRecursive(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(prefix === "" ? root : join(root, prefix), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const matches: string[] = [];
  for (const relativePath of await listFilesRecursive(root)) {
    const content = await readFile(join(root, relativePath));
    if (content.includes(needle)) matches.push(relativePath);
  }
  return matches;
}

describe("Wave-B fixture orchestration", () => {
  it("applies schema-v2 contestant groups with FIFO pacing and durable wait-free timings", async () => {
    const mirrorRoot = await createTestTempRoot("local-maxima-wave-b-v2-repo-");
    await cp(join(repositoryRoot, "challenge"), join(mirrorRoot, "challenge"), {
      recursive: true,
    });
    await mkdir(join(mirrorRoot, "config/profiles/fixture"), { recursive: true });
    const contestantsConfig = parseYaml(
      await readFile(
        join(repositoryRoot, "config/profiles/fixture/contestants.yaml"),
        "utf8",
      ),
    ) as {
      schemaVersion: number;
      resourceGroups?: Record<string, unknown>;
      contestants: Record<string, unknown>[];
    };
    contestantsConfig.schemaVersion = 2;
    contestantsConfig.resourceGroups = {
      alpha: { maximumConcurrency: 1, minimumStartIntervalMs: 750 },
      beta: { maximumConcurrency: 1, minimumStartIntervalMs: 0 },
    };
    contestantsConfig.contestants = contestantsConfig.contestants.map(
      (contestant, index) => ({
        ...contestant,
        execution: {
          resourceGroup: index === 1 ? "beta" : "alpha",
          oneShotEnforcement: "enforced",
        },
      }),
    );
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/contestants.yaml"),
      stringifyYaml(contestantsConfig),
      "utf8",
    );
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/judges.yaml"),
      await readFile(join(repositoryRoot, "config/profiles/fixture/judges.yaml")),
      "utf8",
    );

    const generationsRoot = await createTestTempRoot("local-maxima-wave-b-v2-");
    const generation = await createGeneration({
      repositoryRoot: mirrorRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    let schedulerNow = 0;
    const fixture = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
    });
    const result = await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      contestantAdapterFactory: () => ({
        run: (input) => fixture.run(input),
      }),
      schedulerTime: {
        nowMs: () => schedulerNow,
        wait: async (delayMs) => {
          schedulerNow += delayMs;
        },
      },
      clock: () => new Date(Date.parse("2026-08-28T20:00:00.000Z") + schedulerNow),
    });

    expect(result.contestants.map((entry) => entry.contestantId)).toEqual([
      "fixture-editorial",
      "fixture-geometric",
      "fixture-generic",
    ]);
    const started = result.contestants.map((entry) => [
      entry.contestantId,
      Date.parse(entry.run.startedAt!),
      entry.run.durationMs,
    ]);
    expect(started[0]?.[1]).toBe(Date.parse("2026-08-28T20:00:00.000Z"));
    expect(started[2]?.[1]).toBe(Date.parse("2026-08-28T20:00:00.750Z"));
    expect(started[2]?.[2]).toBe(0);
    expect(started[0]?.[2]).toBe(0);
  }, 30000);

  it("runs judge assessments in stored order with retained group pacing and awards only after valid results", async () => {
    const mirrorRoot = await createTestTempRoot("local-maxima-wave-b-judge-v2-repo-");
    await cp(join(repositoryRoot, "challenge"), join(mirrorRoot, "challenge"), {
      recursive: true,
    });
    await mkdir(join(mirrorRoot, "config/profiles/fixture"), { recursive: true });
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/contestants.yaml"),
      await readFile(join(repositoryRoot, "config/profiles/fixture/contestants.yaml")),
      "utf8",
    );
    const judgesConfig = parseYaml(
      await readFile(
        join(repositoryRoot, "config/profiles/fixture/judges.yaml"),
        "utf8",
      ),
    ) as {
      schemaVersion: number;
      resourceGroups?: Record<string, unknown>;
      judges: Record<string, unknown>[];
    };
    judgesConfig.schemaVersion = 2;
    judgesConfig.resourceGroups = {
      jury: { maximumConcurrency: 2, minimumStartIntervalMs: 250 },
    };
    judgesConfig.judges = judgesConfig.judges.map((judge) => ({
      ...judge,
      execution: { resourceGroup: "jury", oneShotEnforcement: "enforced" },
    }));
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/judges.yaml"),
      stringifyYaml(judgesConfig),
      "utf8",
    );

    const generationsRoot = await createTestTempRoot("local-maxima-wave-b-judge-v2-");
    const generation = await createGeneration({
      repositoryRoot: mirrorRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    let schedulerNow = 0;
    const fixtureContestant = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
    });
    const fixtureJudge = new FixtureJudgeAdapter();
    const events: string[] = [];
    const starts = new Map<string, number>();
    const assessmentCalls = new Map<string, number>();
    const adapterOrder = new Map<string, string[]>();
    const releaseFirst = new Map<string, () => void>();
    const firstReady = new Map<string, Promise<void>>();
    const judgeAdapters = new Map<string, JudgeAdapter>(
      ["fixture-critic-a", "fixture-critic-b"].map((judgeId) => [
        judgeId,
        {
          scoreCandidate: async (input) => {
            const key = `${input.judgeId}/${input.anonymousCandidateId}`;
            starts.set(key, schedulerNow);
            events.push(`start:${key}`);
            const callNumber = (assessmentCalls.get(input.judgeId) ?? 0) + 1;
            assessmentCalls.set(input.judgeId, callNumber);
            const order = adapterOrder.get(input.judgeId) ?? [];
            order.push(key);
            adapterOrder.set(input.judgeId, order);
            if (callNumber === 1) {
              firstReady.set(
                input.judgeId,
                new Promise<void>((resolve) =>
                  releaseFirst.set(input.judgeId, resolve),
                ),
              );
            }
            if (callNumber === 3) releaseFirst.get(input.judgeId)?.();
            const result = await fixtureJudge.scoreCandidate(input);
            if (callNumber === 1) await firstReady.get(input.judgeId);
            else await new Promise<void>((resolve) => setTimeout(resolve, 1));
            events.push(`done:${key}`);
            return result;
          },
          createAwards: async (input) => {
            events.push(`awards:${input.judgeId}`);
            expect(
              events.filter((event) => event.startsWith(`done:${input.judgeId}/`)),
            ).toHaveLength(3);
            return fixtureJudge.createAwards(input);
          },
        },
      ]),
    );
    const result = await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      contestantAdapters: new Map(
        ["fixture-editorial", "fixture-geometric", "fixture-generic"].map((id) => [
          id,
          {
            run: (input: Parameters<typeof fixtureContestant.run>[0]) =>
              fixtureContestant.run(input),
          },
        ]),
      ),
      judgeAdapters,
      schedulerTime: {
        nowMs: () => schedulerNow,
        wait: async (delayMs) => {
          schedulerNow += delayMs;
        },
      },
      clock: () => new Date(Date.parse("2026-08-28T20:00:00.000Z") + schedulerNow),
    });

    expect(result.judges).toHaveLength(2);
    for (const judge of result.judges) {
      expect(
        judge.candidates.map((candidate) => candidate.anonymousCandidateId),
      ).toEqual(judge.assessmentOrder);
      expect(judge.awards?.status).toBe("succeeded");
      const judgeCompletions = events
        .filter((event) => event.startsWith(`done:${judge.judgeId}/`))
        .map((event) => event.slice("done:".length));
      expect(judgeCompletions).not.toEqual(adapterOrder.get(judge.judgeId));
      expect(events.indexOf(`awards:${judge.judgeId}`)).toBeGreaterThan(
        Math.max(
          ...events.map((event, index) =>
            event.startsWith(`done:${judge.judgeId}/`) ? index : -1,
          ),
        ),
      );
    }
    const epoch = Date.parse("2026-08-28T20:00:00.000Z");
    const firstJudgeStarts = result.judges[0]!.candidates.map(
      (candidate) => Date.parse(candidate.startedAt) - epoch,
    );
    expect(firstJudgeStarts).toEqual([0, 250, 500]);
    const secondJudgeFirst = Math.min(
      ...result.judges[1]!.candidates.map(
        (candidate) => Date.parse(candidate.startedAt) - epoch,
      ),
    );
    expect(secondJudgeFirst).toBeGreaterThanOrEqual(750);
    expect([...starts.values()]).toEqual([...starts.values()].sort((a, b) => a - b));
  }, 30000);

  it("honors contestant and per-judge concurrency while preserving stored order", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-concurrency-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixtureContestant = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 20,
    });
    let activeContestants = 0;
    let maximumContestants = 0;
    const contestantAdapter: ContestantAdapter = {
      run: async (input) => {
        activeContestants += 1;
        maximumContestants = Math.max(maximumContestants, activeContestants);
        try {
          return await fixtureContestant.run(input);
        } finally {
          activeContestants -= 1;
        }
      },
    };
    const fixtureJudge = new FixtureJudgeAdapter({ delayMs: 20 });
    let activeAssessments = 0;
    let maximumAssessments = 0;
    const judgeAdapter: JudgeAdapter = {
      scoreCandidate: async (input) => {
        activeAssessments += 1;
        maximumAssessments = Math.max(maximumAssessments, activeAssessments);
        try {
          return await fixtureJudge.scoreCandidate(input);
        } finally {
          activeAssessments -= 1;
        }
      },
      createAwards: (input) => fixtureJudge.createAwards(input),
    };

    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      seasonId: "0001",
      profileId: "fixture",
      contestantAdapters: new Map(
        ["fixture-editorial", "fixture-geometric", "fixture-generic"].map((id) => [
          id,
          contestantAdapter,
        ]),
      ),
      judgeAdapters: new Map([
        ["fixture-critic-a", judgeAdapter],
        ["fixture-critic-b", judgeAdapter],
      ]),
    });

    expect(maximumContestants).toBeGreaterThan(1);
    expect(maximumContestants).toBeLessThanOrEqual(4);
    expect(maximumAssessments).toBe(2);
    expect(result.contestants.map((entry) => entry.contestantId)).toEqual([
      "fixture-editorial",
      "fixture-geometric",
      "fixture-generic",
    ]);
    for (const judge of result.judges) {
      expect(judge.candidates.map((entry) => entry.anonymousCandidateId)).toEqual(
        judge.assessmentOrder,
      );
    }
  }, 30000);

  it("runs the complete fixture Wave-B path with anonymous stored judge artifacts", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-wave-b-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });

    let clockTick = 0;
    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      clock: () => new Date(Date.parse("2026-08-28T20:00:00.000Z") + clockTick++ * 10),
    });

    expect(result.generationPath).toBe(generation.generationPath);
    expect(result.contestants).toHaveLength(3);
    expect(
      new Set(result.contestants.map((contestant) => contestant.run.startedAt)).size,
    ).toBe(3);
    for (const contestant of result.contestants) {
      const run = RunSchema.parse(
        JSON.parse(
          await readFile(join(contestant.path, "run.json"), "utf8"),
        ) as unknown,
      );
      const validation = ValidationSchema.parse(
        JSON.parse(
          await readFile(join(contestant.path, "validation.json"), "utf8"),
        ) as unknown,
      );
      expect(run.status).toBe("succeeded");
      expect(run.attemptCount).toBe(1);
      expect(Date.parse(run.completedAt!) - Date.parse(run.startedAt!)).toBe(
        run.durationMs,
      );
      expect(validation.status).toBe("valid");
      const image = await sharp(join(contestant.path, "screenshot.png")).metadata();
      expect(image.width).toBe(1440);
      expect(image.height).toBe(1200);
      await expect(readdir(join(contestant.path, "workspace"))).rejects.toThrow();
      expect(await readFile(join(contestant.path, "prompt.md"), "utf8")).toContain(
        join(contestant.path, "workspace/submission.css"),
      );
    }
    expect(result.judges).toHaveLength(2);
    const executionOrder = result.contestants.map(
      (contestant) => contestant.anonymousCandidateId,
    );
    for (const judge of result.judges) {
      const contactOrder = ContactSheetOrderSchema.parse(
        JSON.parse(
          await readFile(join(judge.path, "contact-sheet-order.json"), "utf8"),
        ) as unknown,
      );
      const assessmentOrder = JudgeAssessmentOrderSchema.parse(
        JSON.parse(
          await readFile(join(judge.path, "assessment-order.json"), "utf8"),
        ) as unknown,
      );
      expect(
        await sharp(join(judge.path, "contact-sheet.png")).metadata(),
      ).toMatchObject({
        format: "png",
        width: 1600,
        height: 900,
      });
      expect(contactOrder.candidateOrder).toHaveLength(3);
      expect(assessmentOrder.assessmentOrder).toEqual(judge.assessmentOrder);
      expect(assessmentOrder.assessmentOrder).not.toEqual(executionOrder);
      expect(contactOrder.candidateOrder).not.toEqual(executionOrder);
      expect(judge.candidates).toHaveLength(3);
      expect(
        new Set(judge.candidates.map((candidate) => candidate.startedAt)).size,
      ).toBe(3);
      for (const candidate of judge.candidates) {
        expect(
          Date.parse(candidate.completedAt) - Date.parse(candidate.startedAt),
        ).toBe(candidate.durationMs);
      }
      expect(judge.awardsTiming).not.toBeNull();
      expect(
        Date.parse(judge.awardsTiming!.completedAt) -
          Date.parse(judge.awardsTiming!.startedAt),
      ).toBe(judge.awardsTiming!.durationMs);
      for (const candidate of judge.candidates) {
        expect(candidate.result.status).toBe("succeeded");
        expect(candidate.result.response).not.toHaveProperty("modelUsage");
        expect(candidate.durablePath).not.toBeNull();
        const judgment = CandidateJudgmentSchema.parse(
          JSON.parse(await readFile(candidate.durablePath!, "utf8")) as unknown,
        );
        expect(judgment.judgeId).toBe(judge.judgeId);
        expect(
          judgment.critique.split(/[.!?]+/u).filter((part) => part.trim()),
        ).toHaveLength(2);
        const prompt = await readFile(
          join(judge.path, "prompts", `${candidate.anonymousCandidateId}.md`),
          "utf8",
        );
        expect(prompt).not.toContain("modelUsage");
        expect(prompt).not.toContain("Fixture Harness");
        expect(prompt).not.toContain("local-fixture");
        expect(prompt).not.toContain("editorial-model");
        await expect(
          readdir(join(judge.path, "workspaces", candidate.anonymousCandidateId)),
        ).rejects.toThrow();
      }
      const summary = JudgeSummarySchema.parse(
        JSON.parse(
          await readFile(join(judge.path, "judgment-summary.json"), "utf8"),
        ) as unknown,
      );
      expect(summary.entries).toHaveLength(3);
      const taskTimings = JudgeTaskTimingsSchema.parse(
        JSON.parse(
          await readFile(join(judge.path, "task-timings.json"), "utf8"),
        ) as unknown,
      );
      expect(taskTimings.tasks).toHaveLength(4);
      const judgeVisibleFiles = [
        await readFile(join(judge.path, "awards-prompt.md"), "utf8"),
        ...(await Promise.all(
          judge.candidates.map(async (candidate) => {
            return [
              await readFile(
                join(judge.path, "prompts", `${candidate.anonymousCandidateId}.md`),
                "utf8",
              ),
              candidate.result.rawOutput ?? "",
              candidate.durablePath === null
                ? ""
                : await readFile(candidate.durablePath, "utf8"),
            ];
          }),
        )),
      ].flat(2);
      for (const visibleFile of judgeVisibleFiles) {
        expect(visibleFile).not.toContain("fixture-editorial");
        expect(visibleFile).not.toContain("fixture-geometric");
        expect(visibleFile).not.toContain("fixture-generic");
        expect(visibleFile).not.toContain("Fixture Harness");
        expect(visibleFile).not.toContain("local-fixture");
        expect(visibleFile).not.toContain("editorial-model");
        expect(visibleFile).not.toContain("geometric-model");
        expect(visibleFile).not.toContain("generic-model");
      }
      const awards = GenerationAwardsSchema.parse(
        JSON.parse(await readFile(join(judge.path, "awards.json"), "utf8")) as unknown,
      );
      expect(awards.awards.length).toBeLessThanOrEqual(3);
      expect(judge.awards?.status).toBe("succeeded");
      expect(
        await readFile(join(judge.path, "awards-prompt.md"), "utf8"),
      ).not.toContain("Fixture Critic");
      expect(
        await readFile(join(judge.path, "awards-prompt.md"), "utf8"),
      ).not.toContain("fixture-editorial");
    }
    await expect(
      readFile(join(generation.generationPath, "leaderboard.json")),
    ).rejects.toThrow();
    await expect(
      readFile(join(generation.generationPath, "public/index.html")),
    ).rejects.toThrow();
    const manifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(join(generation.generationPath, "manifest.json"), "utf8"),
      ) as unknown,
    );
    expect(manifest.status).toBe("judging_complete");
  }, 30000);

  it("isolates static, execution, timeout, and render failures and judges only rendered candidates", async () => {
    const mirrorRoot = await createTestTempRoot("local-maxima-wave-b-mixed-repo-");
    await cp(join(repositoryRoot, "challenge"), join(mirrorRoot, "challenge"), {
      recursive: true,
    });
    await mkdir(join(mirrorRoot, "config/profiles/fixture"), { recursive: true });
    const contestantsConfig = parseYaml(
      await readFile(
        join(repositoryRoot, "config/profiles/fixture/contestants.yaml"),
        "utf8",
      ),
    ) as {
      schemaVersion: number;
      defaults: Record<string, unknown>;
      contestants: Record<string, unknown>[];
    };
    const baseContestant = contestantsConfig.contestants[0]!;
    contestantsConfig.defaults.timeoutMs = 5;
    const fixtures = [
      ["mixed-valid", "editorial"],
      ["mixed-remote", "invalid-remote"],
      ["mixed-no-submission", "no-submission"],
      ["mixed-failure", "failure"],
      ["mixed-timeout", "timeout"],
      ["mixed-render-failure", "render-failure"],
    ] as const;
    contestantsConfig.contestants = fixtures.map(([id, fixture]) => ({
      ...baseContestant,
      id,
      displayName: `Mixed ${id}`,
      harness: {
        name: "fixture-harness",
        version: "1.0.0",
        adapter: "fixture",
        fixture,
      },
      model: {
        provider: "local-fixture",
        name: `${id}-model`,
        version: "1.0.0",
      },
      budget: { timeoutMs: 5, maximumTotalTokens: 100 },
      enabled: true,
    }));
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/contestants.yaml"),
      stringifyYaml(contestantsConfig),
      "utf8",
    );
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/judges.yaml"),
      await readFile(join(repositoryRoot, "config/profiles/fixture/judges.yaml")),
    );

    const generationsRoot = await createTestTempRoot("local-maxima-wave-b-mixed-");
    const generation = await createGeneration({
      repositoryRoot: mirrorRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixtureAdapter = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const result = await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      contestantAdapterFactory: (contestant) => ({
        run: (input) =>
          fixtureAdapter.run({
            ...input,
            contestant: {
              ...contestant,
              harness:
                contestant.harness.adapter === "fixture"
                  ? {
                      ...contestant.harness,
                      fixture: fixtures.find(([id]) => id === contestant.id)![1],
                    }
                  : contestant.harness,
            },
          }),
      }),
    });

    expect(
      result.contestants.map((contestant) => contestant.validation.status),
    ).toEqual(["valid", "invalid", "invalid", "invalid", "invalid", "render_failed"]);
    expect(result.contestants.map((contestant) => contestant.run.status)).toEqual([
      "succeeded",
      "succeeded",
      "missing_submission",
      "failed",
      "timeout",
      "succeeded",
    ]);
    for (const judge of result.judges) {
      expect(judge.assessmentOrder).toHaveLength(1);
      expect(judge.candidates).toHaveLength(1);
      expect(judge.candidates[0]?.result.status).toBe("succeeded");
      expect(judge.awards?.status).toBe("succeeded");
      expect(judge.awards?.awards?.awards).toEqual([]);
    }
    await expect(readdir(join(result.judges[0]!.path, "workspaces"))).rejects.toThrow();
  }, 30000);

  it("archives an invalid judge response and continues the other judge without awards", async () => {
    const mirrorRoot = await createTestTempRoot(
      "local-maxima-wave-b-invalid-judge-repo-",
    );
    await cp(join(repositoryRoot, "challenge"), join(mirrorRoot, "challenge"), {
      recursive: true,
    });
    await mkdir(join(mirrorRoot, "config/profiles/fixture"), { recursive: true });
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/contestants.yaml"),
      await readFile(join(repositoryRoot, "config/profiles/fixture/contestants.yaml")),
    );
    const judgesConfig = parseYaml(
      await readFile(
        join(repositoryRoot, "config/profiles/fixture/judges.yaml"),
        "utf8",
      ),
    ) as { judges: Record<string, unknown>[]; [key: string]: unknown };
    judgesConfig.judges[0] = {
      ...judgesConfig.judges[0],
      harness: {
        name: "fixture-judge",
        version: "1.0.0",
        adapter: "fixture",
        fixture: "invalid-json",
      },
    };
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/judges.yaml"),
      stringifyYaml(judgesConfig),
      "utf8",
    );

    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-invalid-judge-",
    );
    const generation = await createGeneration({
      repositoryRoot: mirrorRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const contestantAdapter = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const result = await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      contestantAdapters: new Map(
        ["fixture-editorial", "fixture-geometric", "fixture-generic"].map((id) => [
          id,
          contestantAdapter,
        ]),
      ),
    });

    const invalidJudge = result.judges.find(
      (judge) => judge.judgeId === "fixture-critic-a",
    )!;
    expect(invalidJudge.candidates).toHaveLength(3);
    expect(
      invalidJudge.candidates.every(
        (candidate) => candidate.result.status === "invalid",
      ),
    ).toBe(true);
    expect(invalidJudge.awards).toBeNull();
    expect(
      await readFile(
        join(
          invalidJudge.path,
          "raw",
          `${invalidJudge.candidates[0]!.anonymousCandidateId}.json`,
        ),
        "utf8",
      ),
    ).toBe("{ this is not valid judge JSON");
    await expect(
      readFile(join(invalidJudge.path, "awards-prompt.md")),
    ).rejects.toThrow();
    await expect(
      readFile(join(invalidJudge.path, "judgment-summary.json")),
    ).rejects.toThrow();

    const validJudge = result.judges.find(
      (judge) => judge.judgeId === "fixture-critic-b",
    )!;
    expect(validJudge.candidates).toHaveLength(3);
    expect(
      validJudge.candidates.every(
        (candidate) => candidate.result.status === "succeeded",
      ),
    ).toBe(true);
    expect(validJudge.awards?.status).toBe("succeeded");
    expect(
      ManifestSchema.parse(
        JSON.parse(
          await readFile(join(generation.generationPath, "manifest.json"), "utf8"),
        ) as unknown,
      ).status,
    ).toBe("judging_complete");
  }, 30000);

  it("collects only declared command outputs from a contestant workspace", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-command-collection-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const scriptPath = join(generationsRoot, "contestant.mjs");
    const editorialCss = await readFile(
      join(repositoryRoot, "test/fixtures/contestants/editorial.css"),
      "utf8",
    );
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(process.argv[2], ${JSON.stringify(editorialCss)});`,
        "writeFileSync(process.argv[3], JSON.stringify({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }));",
        'writeFileSync("uncollected-output.txt", "must stay private\\n");',
      ].join("\n"),
      "utf8",
    );
    const fixtureAdapter = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const commandAdapter = new CommandContestantAdapter();
    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      contestantAdapterFactory: (contestant) => {
        if (contestant.id !== "fixture-editorial") return fixtureAdapter;
        return {
          run: (input) =>
            commandAdapter.run({
              ...input,
              contestant: {
                ...contestant,
                harness: {
                  name: "command-fixture",
                  version: "1.0.0",
                  adapter: "command",
                  command: {
                    argv: [
                      process.execPath,
                      scriptPath,
                      "{submissionPath}",
                      "{usageOutputPath}",
                    ],
                    environmentAllowlist: [],
                  },
                },
              },
            }),
        };
      },
    });
    const commandContestant = result.contestants.find(
      (contestant) => contestant.contestantId === "fixture-editorial",
    )!;
    expect(commandContestant.run.status).toBe("succeeded");
    expect(commandContestant.validation.status).toBe("valid");
    expect(
      await readFile(join(commandContestant.path, "submission.css"), "utf8"),
    ).toContain("--fixture-style: editorial");
    await expect(
      readFile(join(commandContestant.path, "uncollected-output.txt")),
    ).rejects.toThrow();
    await expect(
      readFile(
        join(commandContestant.path, "workspace/uncollected-output.txt"),
        "utf8",
      ),
    ).rejects.toThrow();
    await expect(readdir(join(commandContestant.path, "workspace"))).rejects.toThrow();
  }, 30000);

  it("does not copy an oversized declared usage file after a bounded read", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-wave-b-usage-cap-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const scriptPath = join(generationsRoot, "oversized-usage-contestant.mjs");
    const editorialCss = await readFile(
      join(repositoryRoot, "test/fixtures/contestants/editorial.css"),
      "utf8",
    );
    await writeFile(
      scriptPath,
      [
        'import { truncateSync, writeFileSync } from "node:fs";',
        `writeFileSync(process.argv[2], ${JSON.stringify(editorialCss)});`,
        'writeFileSync(process.argv[3], "");',
        "truncateSync(process.argv[3], 2 * 1024 * 1024);",
      ].join("\n"),
      "utf8",
    );
    const fixtureAdapter = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const commandAdapter = new CommandContestantAdapter();
    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      contestantAdapterFactory: (contestant) => {
        if (contestant.id !== "fixture-editorial") return fixtureAdapter;
        return {
          run: (input) =>
            commandAdapter.run({
              ...input,
              contestant: {
                ...contestant,
                harness: {
                  name: "oversized-usage-command",
                  version: "1.0.0",
                  adapter: "command",
                  command: {
                    argv: [
                      process.execPath,
                      scriptPath,
                      "{submissionPath}",
                      "{usageOutputPath}",
                    ],
                    environmentAllowlist: [],
                  },
                },
              },
            }),
        };
      },
    });

    const commandContestant = result.contestants.find(
      (contestant) => contestant.contestantId === "fixture-editorial",
    )!;
    expect(commandContestant.run.status).toBe("failed");
    expect(commandContestant.validation.status).toBe("invalid");
    await expect(
      readFile(join(commandContestant.path, "usage.json")),
    ).rejects.toThrow();
  }, 30000);

  it("archives valid contestant execution metadata privately and keeps configured identity separate", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-contestant-meta-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const scriptPath = join(generationsRoot, "meta-contestant.mjs");
    const editorialCss = await readFile(
      join(repositoryRoot, "test/fixtures/contestants/editorial.css"),
      "utf8",
    );
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(process.argv[2], ${JSON.stringify(editorialCss)});`,
        `writeFileSync(process.argv[3], ${JSON.stringify(
          JSON.stringify({
            schemaVersion: 1,
            observedHarnessVersion: "observed-harness-9.9.9",
            observedModelVersion: "observed-model-8.8.8",
            providerRequestId: "req-contestant-private-42",
          }),
        )});`,
      ].join("\n"),
      "utf8",
    );
    const fixtureAdapter = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const commandAdapter = new CommandContestantAdapter();
    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      contestantAdapterFactory: (contestant) => {
        if (contestant.id !== "fixture-editorial") return fixtureAdapter;
        return {
          run: (input) =>
            commandAdapter.run({
              ...input,
              contestant: {
                ...contestant,
                harness: {
                  name: "command-fixture",
                  version: "1.0.0",
                  adapter: "command",
                  command: {
                    argv: [
                      process.execPath,
                      scriptPath,
                      "{submissionPath}",
                      "{executionMetadataOutputPath}",
                    ],
                    environmentAllowlist: [],
                  },
                },
              },
            }),
        };
      },
    });

    const metaContestant = result.contestants.find(
      (contestant) => contestant.contestantId === "fixture-editorial",
    )!;
    expect(metaContestant.run.status).toBe("succeeded");
    expect(metaContestant.run.observedVersions).toEqual({
      harness: "observed-harness-9.9.9",
      model: "observed-model-8.8.8",
    });
    const archived = ExecutionMetadataFileSchema.parse(
      JSON.parse(
        await readFile(join(metaContestant.path, "execution-metadata.json"), "utf8"),
      ) as unknown,
    );
    expect(archived).toEqual({
      schemaVersion: 1,
      observedHarnessVersion: "observed-harness-9.9.9",
      observedModelVersion: "observed-model-8.8.8",
      providerRequestId: "req-contestant-private-42",
    });
    // The immutable identity keeps the *configured* identity, never the
    // observed values reported by the wrapper.
    const identityText = await readFile(
      join(metaContestant.path, "identity.json"),
      "utf8",
    );
    const identity = IdentitySchema.parse(JSON.parse(identityText) as unknown);
    expect(identity.harness.configuredVersion).toBe("1.0.0");
    expect(identity.model.configuredVersion).toBe("1.0.0");
    expect(identityText).not.toContain("observed-harness-9.9.9");
    expect(identityText).not.toContain("req-contestant-private-42");
    // The provider request id is private-only: exactly one durable file.
    expect(
      await filesContaining(generation.generationPath, "req-contestant-private-42"),
    ).toEqual(["contestants/fixture-editorial/execution-metadata.json"]);
    // Fixture contestants exercise the same archival deterministically.
    const fixtureContestant = result.contestants.find(
      (contestant) => contestant.contestantId === "fixture-geometric",
    )!;
    expect(fixtureContestant.run.observedVersions).toEqual({
      harness: "fixture-harness-1.0.0",
      model: "fixture-model-1.0.0",
    });
    expect(
      ExecutionMetadataFileSchema.parse(
        JSON.parse(
          await readFile(
            join(fixtureContestant.path, "execution-metadata.json"),
            "utf8",
          ),
        ) as unknown,
      ),
    ).toEqual({
      schemaVersion: 1,
      observedHarnessVersion: "fixture-harness-1.0.0",
      observedModelVersion: "fixture-model-1.0.0",
      providerRequestId: "fixture-request-contestant-fixture-geometric",
    });
    expect(
      (
        await filesContaining(generation.generationPath, "fixture-request-contestant-")
      ).sort(),
    ).toEqual([
      "contestants/fixture-generic/execution-metadata.json",
      "contestants/fixture-geometric/execution-metadata.json",
    ]);
  }, 30000);

  it("treats missing contestant execution metadata as allowed and explicitly incomplete", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-contestant-meta-missing-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const scriptPath = join(generationsRoot, "plain-meta-contestant.mjs");
    const editorialCss = await readFile(
      join(repositoryRoot, "test/fixtures/contestants/editorial.css"),
      "utf8",
    );
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(process.argv[2], ${JSON.stringify(editorialCss)});`,
      ].join("\n"),
      "utf8",
    );
    const fixtureAdapter = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const commandAdapter = new CommandContestantAdapter();
    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      contestantAdapterFactory: (contestant) => {
        if (contestant.id !== "fixture-editorial") return fixtureAdapter;
        return {
          run: (input) =>
            commandAdapter.run({
              ...input,
              contestant: {
                ...contestant,
                harness: {
                  name: "command-fixture",
                  version: "1.0.0",
                  adapter: "command",
                  command: {
                    argv: [process.execPath, scriptPath, "{submissionPath}"],
                    environmentAllowlist: [],
                  },
                },
              },
            }),
        };
      },
    });

    const plainContestant = result.contestants.find(
      (contestant) => contestant.contestantId === "fixture-editorial",
    )!;
    expect(plainContestant.run.status).toBe("succeeded");
    expect(plainContestant.run.attemptCount).toBe(1);
    expect(plainContestant.run.error).toBeNull();
    // Explicitly incomplete: observed identity stays null, never configured.
    expect(plainContestant.run.observedVersions).toEqual({
      harness: null,
      model: null,
    });
    await expect(
      readFile(join(plainContestant.path, "execution-metadata.json")),
    ).rejects.toThrow();
    expect(plainContestant.validation.status).toBe("valid");
  }, 30000);

  it("bounds invalid or oversized contestant metadata without archiving, retrying, or crashing", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-contestant-meta-bad-",
    );
    const editorialCss = await readFile(
      join(repositoryRoot, "test/fixtures/contestants/editorial.css"),
      "utf8",
    );
    const invalidScriptPath = join(generationsRoot, "invalid-meta.mjs");
    await writeFile(
      invalidScriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(process.argv[2], ${JSON.stringify(editorialCss)});`,
        'writeFileSync(process.argv[3], "{ not valid metadata");',
      ].join("\n"),
      "utf8",
    );
    const oversizedScriptPath = join(generationsRoot, "oversized-meta.mjs");
    await writeFile(
      oversizedScriptPath,
      [
        'import { truncateSync, writeFileSync } from "node:fs";',
        `writeFileSync(process.argv[2], ${JSON.stringify(editorialCss)});`,
        'writeFileSync(process.argv[3], "");',
        "truncateSync(process.argv[3], 2 * 1024 * 1024);",
      ].join("\n"),
      "utf8",
    );
    const fixtureAdapter = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const commandAdapter = new CommandContestantAdapter();
    const mirrorRoot = await createTestTempRoot("local-maxima-wave-b-bad-meta-repo-");
    await cp(join(repositoryRoot, "challenge"), join(mirrorRoot, "challenge"), {
      recursive: true,
    });
    await mkdir(join(mirrorRoot, "config/profiles/fixture"), { recursive: true });
    const contestantsConfig = parseYaml(
      await readFile(
        join(repositoryRoot, "config/profiles/fixture/contestants.yaml"),
        "utf8",
      ),
    ) as {
      schemaVersion: number;
      defaults: Record<string, unknown>;
      contestants: Record<string, unknown>[];
    };
    contestantsConfig.contestants = contestantsConfig.contestants.flatMap(
      (contestant, index) =>
        index === 0
          ? [
              { ...contestant, id: "bad-meta-invalid" },
              { ...contestant, id: "bad-meta-oversized" },
            ]
          : [contestant],
    );
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/contestants.yaml"),
      stringifyYaml(contestantsConfig),
      "utf8",
    );
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/judges.yaml"),
      await readFile(join(repositoryRoot, "config/profiles/fixture/judges.yaml")),
      "utf8",
    );
    const badGeneration = await createGeneration({
      repositoryRoot: mirrorRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const adapterCalls = new Map<string, number>();
    const result = await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: badGeneration.generationPath,
      contestantAdapterFactory: (contestant) => {
        const scriptPath =
          contestant.id === "bad-meta-invalid"
            ? invalidScriptPath
            : contestant.id === "bad-meta-oversized"
              ? oversizedScriptPath
              : null;
        if (scriptPath === null) return fixtureAdapter;
        return {
          run: (input) => {
            adapterCalls.set(contestant.id, (adapterCalls.get(contestant.id) ?? 0) + 1);
            return commandAdapter.run({
              ...input,
              contestant: {
                ...input.contestant,
                harness: {
                  name: "command-fixture",
                  version: "1.0.0",
                  adapter: "command",
                  command: {
                    argv: [
                      process.execPath,
                      scriptPath,
                      "{submissionPath}",
                      "{executionMetadataOutputPath}",
                    ],
                    environmentAllowlist: [],
                  },
                },
              },
            });
          },
        };
      },
    });

    for (const id of ["bad-meta-invalid", "bad-meta-oversized"]) {
      const contestant = result.contestants.find((entry) => entry.contestantId === id)!;
      // Handled, not fatal: the submission itself stays valid on one attempt.
      expect(contestant.run.status).toBe("succeeded");
      expect(contestant.run.attemptCount).toBe(1);
      expect(contestant.validation.status).toBe("valid");
      expect(contestant.run.error).toMatch(/execution metadata/i);
      expect(contestant.run.observedVersions).toEqual({ harness: null, model: null });
      await expect(
        readFile(join(contestant.path, "execution-metadata.json")),
      ).rejects.toThrow();
      expect(adapterCalls.get(id)).toBe(1);
    }
  }, 60000);

  it("archives valid judge execution metadata privately for candidates and awards without leaking request ids", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-wave-b-judge-meta-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const scriptPath = join(generationsRoot, "meta-judge.mjs");
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[2], process.env.OUTPUT);",
        "writeFileSync(process.argv[3], process.env.METADATA);",
      ].join("\n"),
      "utf8",
    );
    const commandJudgeFor = (judge: JudgeConfig) => ({
      ...judge,
      harness: {
        name: "command-judge",
        version: "1.0.0",
        adapter: "command" as const,
        command: {
          argv: [
            process.execPath,
            scriptPath,
            "{judgmentPath}",
            "{executionMetadataOutputPath}",
          ],
          environmentAllowlist: ["OUTPUT", "METADATA"],
        },
      },
    });
    const judgeResponseFor = (input: JudgeCandidateInput) =>
      JSON.stringify({
        schemaVersion: 1,
        generationId: input.generationId,
        judgeId: input.judgeId,
        anonymousCandidateId: input.anonymousCandidateId,
        scores: {
          hierarchyAndReadability: 13,
          composition: 12,
          typography: 12,
          colourAndVisualSystem: 8,
          coherenceAndCraft: 12,
          originalityAndMemorability: 17,
          constraintAndCssCraft: 8,
        },
        totalScore: 82,
        critique:
          "The hierarchy is clear and the palette feels deliberate. Increase the lower-page contrast next.",
        strongestQuality: "Clear hierarchy",
        primaryWeakness: "Quiet lower page",
        nextMove: "Increase lower-page contrast",
        confidence: "medium",
        flags: [],
      });
    const metadataFor = (requestId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        observedHarnessVersion: "observed-judge-harness-9.9.9",
        observedModelVersion: "observed-judge-model-8.8.8",
        providerRequestId: requestId,
      });
    const commandJudge: JudgeAdapter = {
      scoreCandidate: (input) =>
        new CommandJudgeAdapter({
          environment: {
            OUTPUT: judgeResponseFor(input),
            METADATA: metadataFor(`req-judge-private-${input.anonymousCandidateId}`),
          },
        }).scoreCandidate({
          ...input,
          judge: commandJudgeFor(input.judge),
        }),
      createAwards: (input: JudgeAwardsInput) =>
        new CommandJudgeAdapter({
          environment: {
            OUTPUT: JSON.stringify({
              schemaVersion: 1,
              generationId: input.generationId,
              judgeId: input.judgeId,
              awards: [],
            }),
            METADATA: metadataFor("req-judge-private-awards"),
          },
        }).createAwards({
          ...input,
          judge: commandJudgeFor(input.judge),
        }),
    };

    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      judgeAdapterFactory: (judge) =>
        judge.id === "fixture-critic-a"
          ? commandJudge
          : new FixtureJudgeAdapter({ delayMs: 1 }),
    });

    const commandJudged = result.judges.find(
      (judge) => judge.judgeId === "fixture-critic-a",
    )!;
    expect(commandJudged.failure).toBeNull();
    expect(commandJudged.awards?.status).toBe("succeeded");
    expect(commandJudged.candidates).toHaveLength(3);
    for (const candidate of commandJudged.candidates) {
      expect(candidate.result.status).toBe("succeeded");
      expect(candidate.result.metadataProduced).toBe(true);
      expect(candidate.result.executionMetadata).toEqual({
        observedHarnessVersion: "observed-judge-harness-9.9.9",
        observedModelVersion: "observed-judge-model-8.8.8",
        providerRequestId: `req-judge-private-${candidate.anonymousCandidateId}`,
      });
      const archived = ExecutionMetadataFileSchema.parse(
        JSON.parse(
          await readFile(
            join(
              commandJudged.path,
              "execution-metadata",
              `${candidate.anonymousCandidateId}.json`,
            ),
            "utf8",
          ),
        ) as unknown,
      );
      expect(archived).toEqual({
        schemaVersion: 1,
        observedHarnessVersion: "observed-judge-harness-9.9.9",
        observedModelVersion: "observed-judge-model-8.8.8",
        providerRequestId: `req-judge-private-${candidate.anonymousCandidateId}`,
      });
    }
    const archivedAwards = ExecutionMetadataFileSchema.parse(
      JSON.parse(
        await readFile(
          join(commandJudged.path, "execution-metadata", "awards.json"),
          "utf8",
        ),
      ) as unknown,
    );
    expect(archivedAwards.providerRequestId).toBe("req-judge-private-awards");

    // The fixture judge exercises the same archival deterministically.
    const fixtureJudged = result.judges.find(
      (judge) => judge.judgeId === "fixture-critic-b",
    )!;
    for (const candidate of fixtureJudged.candidates) {
      const archived = ExecutionMetadataFileSchema.parse(
        JSON.parse(
          await readFile(
            join(
              fixtureJudged.path,
              "execution-metadata",
              `${candidate.anonymousCandidateId}.json`,
            ),
            "utf8",
          ),
        ) as unknown,
      );
      expect(archived).toEqual({
        schemaVersion: 1,
        observedHarnessVersion: "fixture-judge-harness-1.0.0",
        observedModelVersion: "fixture-judge-model-1.0.0",
        providerRequestId: `fixture-request-judge-fixture-critic-b-${candidate.anonymousCandidateId}`,
      });
    }
    expect(
      ExecutionMetadataFileSchema.parse(
        JSON.parse(
          await readFile(
            join(fixtureJudged.path, "execution-metadata", "awards.json"),
            "utf8",
          ),
        ) as unknown,
      ).providerRequestId,
    ).toBe("fixture-request-judge-fixture-critic-b-awards");

    // Privacy: request ids live only in the private metadata archives.
    expect(
      (await filesContaining(generation.generationPath, "req-judge-private-")).sort(),
    ).toEqual(
      [
        ...commandJudged.candidates.map(
          (candidate) =>
            `judging/fixture-critic-a/execution-metadata/${candidate.anonymousCandidateId}.json`,
        ),
        "judging/fixture-critic-a/execution-metadata/awards.json",
      ].sort(),
    );
    expect(
      (
        await filesContaining(generation.generationPath, "fixture-request-judge-")
      ).sort(),
    ).toEqual(
      [
        ...fixtureJudged.candidates.map(
          (candidate) =>
            `judging/fixture-critic-b/execution-metadata/${candidate.anonymousCandidateId}.json`,
        ),
        "judging/fixture-critic-b/execution-metadata/awards.json",
      ].sort(),
    );
  }, 60000);

  it("treats missing judge execution metadata as allowed with no durable copy, status change, or retry", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-judge-meta-missing-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const scriptPath = join(generationsRoot, "plain-meta-judge.mjs");
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[2], process.env.OUTPUT);",
      ].join("\n"),
      "utf8",
    );
    const commandJudgeFor = (judge: JudgeConfig) => ({
      ...judge,
      harness: {
        name: "command-judge",
        version: "1.0.0",
        adapter: "command" as const,
        command: {
          argv: [process.execPath, scriptPath, "{judgmentPath}"],
          environmentAllowlist: ["OUTPUT"],
        },
      },
    });
    const calls: string[] = [];
    const commandJudge: JudgeAdapter = {
      scoreCandidate: (input) => {
        calls.push(`candidate:${input.anonymousCandidateId}`);
        return new CommandJudgeAdapter({
          environment: {
            OUTPUT: JSON.stringify({
              schemaVersion: 1,
              generationId: input.generationId,
              judgeId: input.judgeId,
              anonymousCandidateId: input.anonymousCandidateId,
              scores: {
                hierarchyAndReadability: 13,
                composition: 12,
                typography: 12,
                colourAndVisualSystem: 8,
                coherenceAndCraft: 12,
                originalityAndMemorability: 17,
                constraintAndCssCraft: 8,
              },
              totalScore: 82,
              critique:
                "The hierarchy is clear and the palette feels deliberate. Increase the lower-page contrast next.",
              strongestQuality: "Clear hierarchy",
              primaryWeakness: "Quiet lower page",
              nextMove: "Increase lower-page contrast",
              confidence: "medium",
              flags: [],
            }),
          },
        }).scoreCandidate({ ...input, judge: commandJudgeFor(input.judge) });
      },
      createAwards: (input) => {
        calls.push("awards");
        return new CommandJudgeAdapter({
          environment: {
            OUTPUT: JSON.stringify({
              schemaVersion: 1,
              generationId: input.generationId,
              judgeId: input.judgeId,
              awards: [],
            }),
          },
        }).createAwards({ ...input, judge: commandJudgeFor(input.judge) });
      },
    };

    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      judgeAdapters: new Map([["fixture-critic-a", commandJudge]]),
    });
    const judged = result.judges.find((judge) => judge.judgeId === "fixture-critic-a")!;
    expect(judged.failure).toBeNull();
    for (const candidate of judged.candidates) {
      expect(candidate.result.status).toBe("succeeded");
      expect(candidate.result.attemptCount).toBe(1);
      expect(candidate.result.metadataProduced).toBe(false);
      expect(candidate.result.executionMetadata).toEqual({
        observedHarnessVersion: null,
        observedModelVersion: null,
        providerRequestId: null,
      });
      expect(candidate.result.error).toBeNull();
      await expect(
        readFile(
          join(
            judged.path,
            "execution-metadata",
            `${candidate.anonymousCandidateId}.json`,
          ),
        ),
      ).rejects.toThrow();
    }
    expect(judged.awards?.status).toBe("succeeded");
    expect(judged.awards?.metadataProduced).toBe(false);
    await expect(
      readFile(join(judged.path, "execution-metadata", "awards.json")),
    ).rejects.toThrow();
    expect(calls.filter((call) => call.startsWith("candidate:"))).toHaveLength(3);
    expect(calls.filter((call) => call === "awards")).toHaveLength(1);
  }, 60000);

  it("bounds invalid or oversized judge metadata without archive, retry, or status change", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-judge-meta-bad-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const invalidScriptPath = join(generationsRoot, "invalid-meta-judge.mjs");
    await writeFile(
      invalidScriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[2], process.env.OUTPUT);",
        'writeFileSync(process.argv[3], "{ not valid metadata");',
      ].join("\n"),
      "utf8",
    );
    const oversizedScriptPath = join(generationsRoot, "oversized-meta-judge.mjs");
    await writeFile(
      oversizedScriptPath,
      [
        'import { truncateSync, writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[2], process.env.OUTPUT);",
        'writeFileSync(process.argv[3], "");',
        "truncateSync(process.argv[3], 2 * 1024 * 1024);",
      ].join("\n"),
      "utf8",
    );
    const commandJudgeFor = (judge: JudgeConfig, scriptPath: string) => ({
      ...judge,
      harness: {
        name: "command-judge",
        version: "1.0.0",
        adapter: "command" as const,
        command: {
          argv: [
            process.execPath,
            scriptPath,
            "{judgmentPath}",
            "{executionMetadataOutputPath}",
          ],
          environmentAllowlist: ["OUTPUT"],
        },
      },
    });
    const callCounts = new Map<string, number>();
    const badMetaJudge = (scriptPath: string): JudgeAdapter => ({
      scoreCandidate: (input) => {
        const key = `candidate:${input.judgeId}:${input.anonymousCandidateId}`;
        callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
        return new CommandJudgeAdapter({
          environment: {
            OUTPUT: JSON.stringify({
              schemaVersion: 1,
              generationId: input.generationId,
              judgeId: input.judgeId,
              anonymousCandidateId: input.anonymousCandidateId,
              scores: {
                hierarchyAndReadability: 13,
                composition: 12,
                typography: 12,
                colourAndVisualSystem: 8,
                coherenceAndCraft: 12,
                originalityAndMemorability: 17,
                constraintAndCssCraft: 8,
              },
              totalScore: 82,
              critique:
                "The hierarchy is clear and the palette feels deliberate. Increase the lower-page contrast next.",
              strongestQuality: "Clear hierarchy",
              primaryWeakness: "Quiet lower page",
              nextMove: "Increase lower-page contrast",
              confidence: "medium",
              flags: [],
            }),
          },
        }).scoreCandidate({
          ...input,
          judge: commandJudgeFor(input.judge, scriptPath),
        });
      },
      createAwards: (input) => {
        callCounts.set(
          `awards:${input.judgeId}`,
          (callCounts.get(`awards:${input.judgeId}`) ?? 0) + 1,
        );
        return new CommandJudgeAdapter({
          environment: {
            OUTPUT: JSON.stringify({
              schemaVersion: 1,
              generationId: input.generationId,
              judgeId: input.judgeId,
              awards: [],
            }),
          },
        }).createAwards({
          ...input,
          judge: commandJudgeFor(input.judge, scriptPath),
        });
      },
    });

    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      judgeAdapters: new Map([
        ["fixture-critic-a", badMetaJudge(invalidScriptPath)],
        ["fixture-critic-b", badMetaJudge(oversizedScriptPath)],
      ]),
    });

    for (const judgeId of ["fixture-critic-a", "fixture-critic-b"]) {
      const judged = result.judges.find((judge) => judge.judgeId === judgeId)!;
      expect(judged.failure).toBeNull();
      for (const candidate of judged.candidates) {
        // Handled, not fatal: the durable judgment still succeeds on one call.
        expect(candidate.result.status).toBe("succeeded");
        expect(candidate.result.attemptCount).toBe(1);
        expect(candidate.result.error).toMatch(/execution metadata/i);
        expect(candidate.result.metadataProduced).toBe(true);
        expect(candidate.result.executionMetadata).toEqual({
          observedHarnessVersion: null,
          observedModelVersion: null,
          providerRequestId: null,
        });
        expect(candidate.durablePath).not.toBeNull();
        await expect(
          readFile(
            join(
              judged.path,
              "execution-metadata",
              `${candidate.anonymousCandidateId}.json`,
            ),
          ),
        ).rejects.toThrow();
        expect(
          callCounts.get(`candidate:${judgeId}:${candidate.anonymousCandidateId}`),
        ).toBe(1);
      }
      expect(judged.awards?.status).toBe("succeeded");
      expect(judged.awards?.error).toMatch(/execution metadata/i);
      await expect(
        readFile(join(judged.path, "execution-metadata", "awards.json")),
      ).rejects.toThrow();
      expect(callCounts.get(`awards:${judgeId}`)).toBe(1);
    }
  }, 60000);

  it("does not mark a judge candidate successful when usage archival is oversized", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-judge-usage-cap-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixtureJudge = new FixtureJudgeAdapter();
    const oversizedJudge: JudgeAdapter = {
      scoreCandidate: async (input) => {
        const result = await fixtureJudge.scoreCandidate(input);
        await writeFile(input.usageOutputPath, "", "utf8");
        await truncate(input.usageOutputPath, 2 * 1024 * 1024);
        return result;
      },
      createAwards: (input) => fixtureJudge.createAwards(input),
    };

    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      judgeAdapters: new Map([["fixture-critic-a", oversizedJudge]]),
    });
    const failedJudge = result.judges.find(
      (judge) => judge.judgeId === "fixture-critic-a",
    )!;
    expect(
      failedJudge.candidates.some((candidate) => candidate.result.status === "failed"),
    ).toBe(true);
    expect(failedJudge.awards).toBeNull();
    expect(failedJudge.failure).toMatch(/usage|collect|archive/i);
    expect(
      result.judges.find((judge) => judge.judgeId === "fixture-critic-b")?.awards
        ?.status,
    ).toBe("succeeded");
  }, 30000);

  it("records a bounded awards failure and continues the other judge", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-awards-failure-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixtureJudge = new FixtureJudgeAdapter();
    const awardsFailure: JudgeAdapter = {
      scoreCandidate: (input) => fixtureJudge.scoreCandidate(input),
      createAwards: async () => ({
        status: "failed" as const,
        awards: null,
        rawOutput: null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          estimatedCostUsd: null,
        },
        error: "injected awards failure",
        timedOut: false,
        attemptCount: 1 as const,
        executionMetadata: emptyExecutionMetadata(),
        metadataProduced: false,
      }),
    };

    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      judgeAdapters: new Map([["fixture-critic-a", awardsFailure]]),
    });
    const failedJudge = result.judges.find(
      (judge) => judge.judgeId === "fixture-critic-a",
    )!;
    expect(failedJudge.awards?.status).toBe("failed");
    expect(failedJudge.failure).toMatch(/awards|injected/i);
    expect(await readFile(join(failedJudge.path, "failure.txt"), "utf8")).toMatch(
      /awards|injected/i,
    );
    expect(
      result.judges.find((judge) => judge.judgeId === "fixture-critic-b")?.awards
        ?.status,
    ).toBe("succeeded");
  }, 30000);

  it("isolates one candidate assessment failure while later candidates continue", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-candidate-failure-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixtureJudge = new FixtureJudgeAdapter();
    let injected = false;
    const candidateFailure: JudgeAdapter = {
      scoreCandidate: async (input) => {
        if (!injected) {
          injected = true;
          throw new Error("injected candidate assessment failure");
        }
        return fixtureJudge.scoreCandidate(input);
      },
      createAwards: (input) => fixtureJudge.createAwards(input),
    };

    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      judgeAdapters: new Map([["fixture-critic-a", candidateFailure]]),
    });
    const failedJudge = result.judges.find(
      (judge) => judge.judgeId === "fixture-critic-a",
    )!;
    expect(failedJudge.candidates).toHaveLength(3);
    expect(
      failedJudge.candidates.filter(
        (candidate) => candidate.result.status === "failed",
      ),
    ).toHaveLength(1);
    expect(
      failedJudge.candidates.filter(
        (candidate) => candidate.result.status === "succeeded",
      ),
    ).toHaveLength(2);
    expect(failedJudge.awards).toBeNull();
    expect(
      result.judges.find((judge) => judge.judgeId === "fixture-critic-b")?.awards
        ?.status,
    ).toBe("succeeded");
  }, 30000);

  it("rejects a contestant that modifies its challenge HTML or font workspace", async () => {
    const mirrorRoot = await createTestTempRoot(
      "local-maxima-wave-b-input-tamper-repo-",
    );
    await cp(join(repositoryRoot, "challenge"), join(mirrorRoot, "challenge"), {
      recursive: true,
    });
    await mkdir(join(mirrorRoot, "config/profiles/fixture"), { recursive: true });
    const contestantsConfig = parseYaml(
      await readFile(
        join(repositoryRoot, "config/profiles/fixture/contestants.yaml"),
        "utf8",
      ),
    ) as {
      defaults: Record<string, unknown>;
      resourceGroups?: Record<string, unknown>;
      contestants: Record<string, unknown>[];
    };
    contestantsConfig.defaults.concurrency = 1;
    contestantsConfig.resourceGroups = {
      "tamper-lane": { maximumConcurrency: 1, minimumStartIntervalMs: 0 },
    };
    contestantsConfig.contestants[0]!.harness = {
      name: "tampering-command",
      version: "1.0.0",
      adapter: "command",
      command: {
        argv: [
          process.execPath,
          join(mirrorRoot, "tamper.mjs"),
          "{workspacePath}",
          "{submissionPath}",
          "{promptPath}",
        ],
        environmentAllowlist: [],
      },
    };
    contestantsConfig.contestants[0]!.execution = {
      resourceGroup: "tamper-lane",
      oneShotEnforcement: "enforced",
    };
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/contestants.yaml"),
      stringifyYaml(contestantsConfig),
      "utf8",
    );
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/judges.yaml"),
      await readFile(join(repositoryRoot, "config/profiles/fixture/judges.yaml")),
    );
    await writeFile(
      join(mirrorRoot, "tamper.mjs"),
      [
        'import { appendFileSync, chmodSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'chmodSync(join(process.argv[2], "challenge.html"), 0o644);',
        'chmodSync(join(process.argv[2], "fonts/lm-mono.ttf"), 0o644);',
        'appendFileSync(join(process.argv[2], "challenge.html"), "\\n<!-- tampered -->\\n");',
        'appendFileSync(join(process.argv[2], "fonts/lm-mono.ttf"), "tampered");',
        'writeFileSync(process.argv[3], "body { color: red; }\\n");',
      ].join("\n"),
      "utf8",
    );

    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-input-tamper-",
    );
    const generation = await createGeneration({
      repositoryRoot: mirrorRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });

    const result = await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      allowModelCalls: true,
      contestantAdapters: new Map(
        ["fixture-geometric", "fixture-generic"].map((id) => [
          id,
          new FixtureContestantAdapter({
            fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
          }),
        ]),
      ),
    });
    const tampered = result.contestants.find(
      (contestant) => contestant.contestantId === "fixture-editorial",
    )!;
    expect(tampered.validation.status).toBe("invalid");
    expect(tampered.screenshotPath).toBeNull();
  }, 30000);

  it("stops before accepting a screenshot when a harness tampers with canonical challenge inputs", async () => {
    const mirrorRoot = await createTestTempRoot(
      "local-maxima-wave-b-canonical-tamper-repo-",
    );
    await cp(join(repositoryRoot, "challenge"), join(mirrorRoot, "challenge"), {
      recursive: true,
    });
    await mkdir(join(mirrorRoot, "config/profiles/fixture"), { recursive: true });
    const contestantsConfig = parseYaml(
      await readFile(
        join(repositoryRoot, "config/profiles/fixture/contestants.yaml"),
        "utf8",
      ),
    ) as {
      defaults: Record<string, unknown>;
      resourceGroups?: Record<string, unknown>;
      contestants: Record<string, unknown>[];
    };
    contestantsConfig.defaults.concurrency = 1;
    contestantsConfig.resourceGroups = {
      "tamper-lane": { maximumConcurrency: 1, minimumStartIntervalMs: 0 },
    };
    contestantsConfig.contestants[0]!.harness = {
      name: "canonical-tampering-command",
      version: "1.0.0",
      adapter: "command",
      command: {
        argv: [
          process.execPath,
          join(mirrorRoot, "tamper-canonical.mjs"),
          "{workspacePath}",
          "{submissionPath}",
          "{promptPath}",
        ],
        environmentAllowlist: [],
      },
    };
    contestantsConfig.contestants[0]!.execution = {
      resourceGroup: "tamper-lane",
      oneShotEnforcement: "enforced",
    };
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/contestants.yaml"),
      stringifyYaml(contestantsConfig),
      "utf8",
    );
    await writeFile(
      join(mirrorRoot, "config/profiles/fixture/judges.yaml"),
      await readFile(join(repositoryRoot, "config/profiles/fixture/judges.yaml")),
    );
    await writeFile(
      join(mirrorRoot, "tamper-canonical.mjs"),
      [
        'import { appendFileSync, chmodSync, writeFileSync } from "node:fs";',
        'import { resolve } from "node:path";',
        'const canonicalPath = resolve(process.argv[2], "../../../challenge/challenge.html");',
        "chmodSync(canonicalPath, 0o644);",
        'appendFileSync(canonicalPath, "\\n<!-- canonical tampered -->\\n");',
        'writeFileSync(process.argv[3], "body { color: red; }\\n");',
      ].join("\n"),
      "utf8",
    );

    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-canonical-tamper-",
    );
    const generation = await createGeneration({
      repositoryRoot: mirrorRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });

    await expect(
      runWaveB({
        repositoryRoot: mirrorRoot,
        generationPath: generation.generationPath,
        allowModelCalls: true,
        contestantAdapters: new Map(
          ["fixture-geometric", "fixture-generic"].map((id) => [
            id,
            new FixtureContestantAdapter({
              fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
            }),
          ]),
        ),
      }),
    ).rejects.toThrow(/canonical|integrity|challenge/i);
  }, 30000);

  it("isolates a contact-sheet setup failure to one judge and continues later judges", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-contact-failure-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });

    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      contactSheetBuilder: async (input) => {
        if (input.judgeId === "fixture-critic-a") {
          throw new Error("injected contact-sheet failure");
        }
        return buildAnonymousContactSheet(input);
      },
    });

    expect(result.judges[0]?.failure).toMatch(/contact-sheet|injected/i);
    expect(result.judges[0]?.candidates).toEqual([]);
    expect(result.judges[1]?.contactSheet).not.toBeNull();
    expect(result.judges[1]?.candidates.length).toBeGreaterThan(0);
  }, 30000);

  it("isolates an unexpected judge setup failure and continues later judges", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-judge-isolation-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });

    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      contactSheetBuilder: async (input) => {
        const built = await buildAnonymousContactSheet(input);
        if (input.judgeId === "fixture-critic-a") {
          return null as unknown as Awaited<
            ReturnType<typeof buildAnonymousContactSheet>
          >;
        }
        return built;
      },
    });

    expect(result.judges).toHaveLength(2);
    expect(result.judges[0]?.failure).toMatch(/judge|setup|contact/i);
    expect(result.judges[0]?.candidates).toEqual([]);
    expect(result.judges[1]?.candidates.length).toBeGreaterThan(0);
    expect(await readFile(join(result.judges[0]!.path, "failure.txt"), "utf8")).toMatch(
      /judge|setup|contact/i,
    );
  }, 30000);

  it("isolates per-candidate staging failures and continues the other judge", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-staging-failure-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });

    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      contactSheetBuilder: async (input) => {
        const built = await buildAnonymousContactSheet(input);
        return input.judgeId === "fixture-critic-a"
          ? { ...built, outputPath: `${built.outputPath}.missing` }
          : built;
      },
    });
    const failedJudge = result.judges.find(
      (judge) => judge.judgeId === "fixture-critic-a",
    )!;
    expect(failedJudge.candidates).toHaveLength(3);
    expect(
      failedJudge.candidates.every((candidate) => candidate.result.status === "failed"),
    ).toBe(true);
    expect(failedJudge.failure).toMatch(/candidate|stage|staging/i);
    expect(
      result.judges.find((judge) => judge.judgeId === "fixture-critic-b")?.candidates
        .length,
    ).toBe(3);
  }, 30000);

  it("rejects tampered sanitised CSS before staging it for a judge", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-sanitised-tamper-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const firstRun = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      seasonId: "0001",
      profileId: "fixture",
    });
    const target = firstRun.contestants[0]!;
    await writeFile(
      join(target.path, "sanitised.css"),
      ":root { --tampered: true; }\n",
      "utf8",
    );

    const secondRun = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      seasonId: "0001",
      profileId: "fixture",
    });
    const candidateId = target.anonymousCandidateId;
    for (const judge of secondRun.judges) {
      const assessment = judge.candidates.find(
        (candidate) => candidate.anonymousCandidateId === candidateId,
      );
      expect(assessment?.result.status).toBe("failed");
      expect(assessment?.result.error).toMatch(/sanitised|hash|canonical/i);
      expect(assessment?.durablePath).toBeNull();
    }
  }, 30000);

  it("domain-separates judge seeds when the injected random source repeats bytes", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-seed-domains-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      randomBytes: (size) => Buffer.alloc(size, 0x5a),
    });

    const seeds: string[] = [];
    for (const judge of result.judges) {
      const contactOrder = ContactSheetOrderSchema.parse(
        JSON.parse(
          await readFile(join(judge.path, "contact-sheet-order.json"), "utf8"),
        ) as unknown,
      );
      const assessmentOrder = JudgeAssessmentOrderSchema.parse(
        JSON.parse(
          await readFile(join(judge.path, "assessment-order.json"), "utf8"),
        ) as unknown,
      );
      seeds.push(contactOrder.seed, assessmentOrder.seed);
    }
    expect(new Set(seeds).size).toBe(seeds.length);
  }, 30000);

  it("stops when canonical challenge inputs change during rendering", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-render-integrity-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const canonicalHtmlPath = join(
      generation.generationPath,
      "challenge/challenge.html",
    );
    let tampered = false;

    await expect(
      runWaveB({
        repositoryRoot,
        generationPath: generation.generationPath,
        renderer: {
          render: async (input) => {
            if (!tampered) {
              tampered = true;
              await chmod(canonicalHtmlPath, 0o644);
              await appendFile(
                canonicalHtmlPath,
                "\n<!-- tampered during render -->\n",
              );
            }
            return {
              status: "valid" as const,
              screenshotPath: input.screenshotPath,
              renderChecks: [],
              errors: [],
              warnings: [],
              externalRequests: [],
              observedVersions: {
                playwright: "test",
                chromium: "test",
              },
            };
          },
        },
      }),
    ).rejects.toThrow(/canonical|integrity|challenge/i);
  }, 30000);

  it("rejects generation config tampering even when its manifest hash is rewritten", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-wave-b-config-integrity-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const contestantsConfigPath = join(
      generation.generationPath,
      "config/contestants.yaml",
    );
    const tamperedConfig = `${await readFile(contestantsConfigPath, "utf8")}\n# tampered\n`;
    await writeFile(contestantsConfigPath, tamperedConfig, "utf8");
    const manifestPath = join(generation.generationPath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      configHashes: { contestants: string };
    };
    manifest.configHashes.contestants = createHash("sha256")
      .update(tamperedConfig)
      .digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    await expect(
      runWaveB({
        repositoryRoot,
        generationPath: generation.generationPath,
        seasonId: "0001",
        profileId: "fixture",
      }),
    ).rejects.toThrow(/canonical|snapshot|manifest|integrity/i);
  }, 30000);
});
