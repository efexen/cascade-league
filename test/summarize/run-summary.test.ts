import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import {
  AnonymousMapSchema,
  CandidateJudgmentSchema,
  GenerationAwardsSchema,
  IdentitySchema,
  JudgeTaskTimingsSchema,
  LeaderboardSchema,
  ManifestSchema,
  RunPlanSchema,
  RunSchema,
  TaskStateSchema,
  type Manifest,
} from "../../src/schemas/index.js";
import { createGeneration } from "../../src/artifacts/generation.js";
import { runWaveB } from "../../src/orchestration/wave-b.js";
import {
  ExecutionMetadataFileSchema,
  writeTextAtomically,
} from "../../src/contestants/support.js";
import {
  buildRunSummary,
  serializeRunSummary,
  writeRunSummary,
} from "../../src/summarize/index.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const GENERATION_ID = "0001";
const SEASON_ID = "0001";
const CREATED_AT = "2026-08-30T10:00:00.000Z";
const STARTED_AT = "2026-08-30T10:00:05.000Z";
const COMPLETED_AT = "2026-08-30T10:05:05.000Z";

const CONTESTANT_IDS = ["contestant-a", "contestant-b"] as const;
const JUDGE_IDS = ["judge-a"] as const;
const ANONYMOUS_IDS: Record<string, string> = {
  "contestant-a": "candidate-aaaa",
  "contestant-b": "candidate-bbbb",
};

function sha(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64);
}

function manifestDocument(overrides: Partial<Manifest> = {}): Manifest {
  return ManifestSchema.parse({
    schemaVersion: 1,
    seasonId: SEASON_ID,
    generationId: GENERATION_ID,
    status: "completed",
    createdAt: CREATED_AT,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    previousGenerationId: null,
    challengeVersion: "season-1-v1",
    configHashes: {
      challenge: sha("a"),
      contestants: sha("b"),
      judges: sha("c"),
    },
    environment: {
      os: "macOS",
      architecture: "arm64",
      nodeVersion: "v24.0.0",
      playwrightVersion: "1.55.0",
      chromiumVersion: "141.0.7390.54",
    },
    contestantIds: [...CONTESTANT_IDS],
    judgeIds: [...JUDGE_IDS],
    errors: [],
    ...overrides,
  });
}

function contestantsDocument(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    defaults: {
      timeoutMs: 480000,
      maximumTotalTokens: 30000,
      maximumSubmissionBytes: 61440,
      concurrency: 4,
    },
    resourceGroups: {
      lane: { maximumConcurrency: 2, minimumStartIntervalMs: 500 },
    },
    contestants: [
      {
        id: "contestant-a",
        displayName: "Contestant A",
        harness: {
          name: "harness-a",
          version: "1.0.0",
          adapter: "command",
          command: {
            argv: ["/absolute/harness", "{workspacePath}", "{usageOutputPath}"],
            environmentAllowlist: [],
          },
        },
        model: { provider: "provider-a", name: "model-a", version: "1.0.0" },
        budget: { timeoutMs: 480000, maximumTotalTokens: 30000 },
        execution: { resourceGroup: "lane", oneShotEnforcement: "enforced" },
        enabled: true,
      },
      {
        id: "contestant-b",
        displayName: "Contestant B",
        harness: {
          name: "harness-b",
          version: "2.0.0",
          adapter: "command",
          command: {
            argv: ["/absolute/harness", "{workspacePath}", "{usageOutputPath}"],
            environmentAllowlist: [],
          },
        },
        model: { provider: "provider-b", name: "model-b", version: "2.0.0" },
        budget: { timeoutMs: 480000, maximumTotalTokens: 30000 },
        execution: { resourceGroup: "lane", oneShotEnforcement: "prompt_only" },
        enabled: true,
      },
    ],
  };
}

function judgesDocument(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    defaults: {
      timeoutMs: 180000,
      maximumOutputTokens: 4000,
      concurrencyPerJudge: 2,
    },
    resourceGroups: {
      jury: { maximumConcurrency: 2, minimumStartIntervalMs: 250 },
    },
    judges: [
      {
        id: "judge-a",
        displayName: "Judge A",
        harness: {
          name: "judge-harness",
          version: "1.0.0",
          adapter: "command",
          command: {
            argv: ["/absolute/judge", "{workspacePath}", "{usageOutputPath}"],
            environmentAllowlist: [],
          },
        },
        model: { provider: "provider-j", name: "judge-model", version: "1.0.0" },
        budget: { timeoutMs: 180000, maximumOutputTokens: 4000 },
        execution: { resourceGroup: "jury", oneShotEnforcement: "enforced" },
        enabled: true,
      },
    ],
  };
}

function runPlanDocument(): unknown {
  return RunPlanSchema.parse({
    schemaVersion: 1,
    seasonId: SEASON_ID,
    generationId: GENERATION_ID,
    previousGenerationId: null,
    profileId: "temp",
    contestants: [
      { id: "contestant-a", displayName: "Contestant A" },
      { id: "contestant-b", displayName: "Contestant B" },
    ],
    judges: [{ id: "judge-a", displayName: "Judge A" }],
    externalModelCallsRequired: true,
    callCounts: {
      contestantCalls: 2,
      candidateJudgingCalls: 2,
      awardsCalls: 1,
      maximumTotalCalls: 5,
    },
    ceilings: {
      contestants: [
        { id: "contestant-a", timeoutMs: 480000, maximumTotalTokens: 30000 },
        { id: "contestant-b", timeoutMs: 480000, maximumTotalTokens: 30000 },
      ],
      judges: [{ id: "judge-a", timeoutMs: 180000, maximumOutputTokens: 4000 }],
    },
    resourceGroups: {
      jury: {
        maximumConcurrency: 2,
        minimumStartIntervalMs: 250,
        entryIds: ["judge-a"],
      },
      lane: {
        maximumConcurrency: 2,
        minimumStartIntervalMs: 500,
        entryIds: ["contestant-a", "contestant-b"],
      },
    },
    usageReportingUnsupported: [],
    promptOnlyOneShot: ["contestant-b"],
    promptOnlyOneShotAccepted: true,
    configSnapshotHashes: {
      "config/contestants.yaml": sha("11"),
      "config/judges.yaml": sha("22"),
      "config/profile.json": sha("33"),
    },
  });
}

function identityDocument(contestantId: string): unknown {
  return IdentitySchema.parse({
    schemaVersion: 1,
    contestantId,
    anonymousCandidateId: ANONYMOUS_IDS[contestantId],
    displayName: `Contestant ${contestantId.slice(-1)}`,
    harness: {
      name: contestantId === "contestant-a" ? "harness-a" : "harness-b",
      configuredVersion: "1.0.0",
    },
    model: {
      provider: contestantId === "contestant-a" ? "provider-a" : "provider-b",
      name: contestantId === "contestant-a" ? "model-a" : "model-b",
      configuredVersion: contestantId === "contestant-a" ? "1.0.0" : "2.0.0",
    },
  });
}

export interface RunFixture {
  readonly status: "succeeded" | "timeout" | "uncertain" | "failed" | "pending";
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
    estimatedCostUsd: number | null;
  };
  readonly observedVersions: { harness: string | null; model: string | null };
}

function runDocument(contestantId: string, fixture: RunFixture): unknown {
  return RunSchema.parse({
    schemaVersion: 1,
    taskId: `${GENERATION_ID}-contestant-${ANONYMOUS_IDS[contestantId]}`,
    status: fixture.status,
    startedAt: fixture.startedAt,
    completedAt: fixture.completedAt,
    durationMs: fixture.durationMs,
    exitCode: fixture.status === "succeeded" ? 0 : null,
    timedOut: fixture.status === "timeout",
    attemptCount: fixture.status === "pending" ? 0 : 1,
    configuredBudget: { timeoutMs: 480000, maximumTotalTokens: 30000 },
    usage: { ...fixture.usage, tokenLimitEnforced: false },
    observedVersions: fixture.observedVersions,
    stdoutLog: `logs/contestant-${ANONYMOUS_IDS[contestantId]}.stdout.log`,
    stderrLog: `logs/contestant-${ANONYMOUS_IDS[contestantId]}.stderr.log`,
    error: null,
  });
}

export type TaskFixtureStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "missing_submission"
  | "invalid"
  | "uncertain";

function taskDocument(
  role: "contestant" | "render" | "judge" | "awards",
  targetId: string,
  taskId: string,
  status: TaskFixtureStatus,
  startedAt: string | null,
  completedAt: string | null,
): unknown {
  return TaskStateSchema.parse({
    schemaVersion: 1,
    taskId,
    role,
    targetId,
    status,
    startedAt: status === "pending" ? null : startedAt,
    completedAt: status === "pending" || status === "running" ? null : completedAt,
    attemptCount: status === "pending" ? 0 : 1,
    requestAccepted: null,
    error: null,
  });
}

function timingsDocument(): unknown {
  return JudgeTaskTimingsSchema.parse({
    schemaVersion: 1,
    generationId: GENERATION_ID,
    judgeId: "judge-a",
    tasks: [
      {
        operation: "candidate",
        anonymousCandidateId: "candidate-aaaa",
        startedAt: "2026-08-30T10:01:00.000Z",
        completedAt: "2026-08-30T10:01:03.000Z",
        durationMs: 3000,
      },
      {
        operation: "candidate",
        anonymousCandidateId: "candidate-bbbb",
        startedAt: "2026-08-30T10:01:02.000Z",
        completedAt: "2026-08-30T10:01:04.000Z",
        durationMs: 2000,
      },
      {
        operation: "awards",
        anonymousCandidateId: null,
        startedAt: "2026-08-30T10:02:00.000Z",
        completedAt: "2026-08-30T10:02:01.000Z",
        durationMs: 1000,
      },
    ],
  });
}

function metadataDocument(requestId: string): unknown {
  return ExecutionMetadataFileSchema.parse({
    schemaVersion: 1,
    observedHarnessVersion: "observed-harness-9.9.9",
    observedModelVersion: "observed-model-8.8.8",
    providerRequestId: requestId,
  });
}

function judgmentDocument(anonymousCandidateId: string): unknown {
  return CandidateJudgmentSchema.parse({
    schemaVersion: 1,
    generationId: GENERATION_ID,
    judgeId: "judge-a",
    anonymousCandidateId,
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
    modelUsage: {
      inputTokens: 111,
      outputTokens: 22,
      totalTokens: 133,
      estimatedCostUsd: 0.00390625,
    },
  });
}

function leaderboardDocument(): unknown {
  return LeaderboardSchema.parse({
    schemaVersion: 1,
    seasonId: SEASON_ID,
    generationId: GENERATION_ID,
    generatedAt: COMPLETED_AT,
    rankingMethod: "mean-valid-judge-score-v1",
    expectedJudgeCount: 1,
    entries: CONTESTANT_IDS.map((contestantId, index) => ({
      rank: index + 1,
      contestantId,
      displayName: `Contestant ${contestantId.slice(-1)}`,
      harnessName: "harness",
      modelName: "model",
      status: "valid",
      screenshotPath: `contestants/${contestantId}/screenshot.png`,
      combinedScore: 70 + index,
      medianScore: 70 + index,
      originalityScore: 15,
      completedJudgeCount: 1,
      expectedJudgeCount: 1,
      judgeScores: [
        {
          judgeId: "judge-a",
          totalScore: 70 + index,
          originalityScore: 15,
          critique: "Clear structure overall. The palette feels deliberate.",
        },
      ],
      awards: [],
      failure: null,
    })),
  });
}

export interface DurableGenerationOverrides {
  readonly manifest?: Partial<Manifest>;
  readonly omitRunPlan?: boolean;
  readonly omitTaskStates?: boolean;
  readonly omitLeaderboard?: boolean;
  readonly omitTimings?: boolean;
  readonly omitJudgeMetadata?: boolean;
  readonly configVersion?: 1 | 2;
  readonly contestantRuns?: Partial<Record<string, Partial<RunFixture>>>;
  readonly contestantTaskStatuses?: Partial<Record<string, TaskFixtureStatus>>;
  readonly renderTaskStatuses?: Partial<Record<string, TaskFixtureStatus>>;
  readonly judgeTaskStatuses?: Partial<Record<string, TaskFixtureStatus>>;
  readonly awardsTaskStatus?: TaskFixtureStatus;
  readonly judgeUsage?: Partial<
    Record<"candidate-aaaa" | "candidate-bbbb" | "awards", unknown | null>
  >;
  readonly judgments?: Partial<Record<"candidate-aaaa" | "candidate-bbbb", unknown>>;
  readonly leaderboard?: unknown;
  readonly timings?: unknown;
}

const DEFAULT_RUNS: Record<string, RunFixture> = {
  "contestant-a": {
    status: "succeeded",
    startedAt: "2026-08-30T10:00:05.000Z",
    completedAt: "2026-08-30T10:00:10.000Z",
    durationMs: 5000,
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 200,
      totalTokens: 1500,
      estimatedCostUsd: 0.25,
    },
    observedVersions: { harness: "harness-a-1.0.0", model: "model-a-1.0.0" },
  },
  "contestant-b": {
    status: "timeout",
    startedAt: "2026-08-30T10:00:05.500Z",
    completedAt: "2026-08-30T10:00:09.500Z",
    durationMs: 4000,
    usage: {
      inputTokens: 200,
      outputTokens: 100,
      reasoningTokens: 50,
      totalTokens: 300,
      estimatedCostUsd: 0.5,
    },
    observedVersions: { harness: "harness-b-2.0.0", model: "model-b-2.0.0" },
  },
};

/**
 * Builds a complete, schema-valid, durable generation tree containing only
 * artifacts that real Phase 2 runs persist, written with the same canonical
 * pretty-JSON-plus-newline serialization the pipeline writers use.
 */
export async function buildDurableGeneration(
  overrides: DurableGenerationOverrides = {},
): Promise<string> {
  const root = await createTestTempRoot("local-maxima-run-summary-");
  const generationPath = join(root, GENERATION_ID);
  await mkdir(join(generationPath, "config"), { recursive: true });
  await mkdir(join(generationPath, "contestants"), { recursive: true });
  await mkdir(join(generationPath, "judging"), { recursive: true });

  const downgradeToV1 = overrides.configVersion === 1;
  const contestantsYaml = contestantsDocument();
  const judgesYaml = judgesDocument();
  if (downgradeToV1) {
    delete contestantsYaml.resourceGroups;
    delete judgesYaml.resourceGroups;
    for (const entry of contestantsYaml.contestants as Record<string, unknown>[]) {
      delete entry.execution;
    }
    for (const entry of judgesYaml.judges as Record<string, unknown>[]) {
      delete entry.execution;
    }
    contestantsYaml.schemaVersion = 1;
    judgesYaml.schemaVersion = 1;
  }

  await writeJson(
    join(generationPath, "manifest.json"),
    manifestDocument(overrides.manifest ?? {}),
  );
  await writeFile(
    join(generationPath, "config", "contestants.yaml"),
    stringifyYaml(contestantsYaml),
    "utf8",
  );
  await writeFile(
    join(generationPath, "config", "judges.yaml"),
    stringifyYaml(judgesYaml),
    "utf8",
  );
  if (overrides.omitRunPlan !== true) {
    await writeJson(join(generationPath, "run-plan.json"), runPlanDocument());
  }

  await writeJson(
    join(generationPath, "judging", "anonymous-map.json"),
    AnonymousMapSchema.parse({
      schemaVersion: 1,
      generationId: GENERATION_ID,
      entries: CONTESTANT_IDS.map((contestantId) => ({
        contestantId,
        anonymousCandidateId: ANONYMOUS_IDS[contestantId],
      })),
    }),
  );

  for (const contestantId of CONTESTANT_IDS) {
    const contestantPath = join(generationPath, "contestants", contestantId);
    await mkdir(contestantPath, { recursive: true });
    await writeJson(
      join(contestantPath, "identity.json"),
      identityDocument(contestantId),
    );
    const base = DEFAULT_RUNS[contestantId]!;
    const runOverride = overrides.contestantRuns?.[contestantId] ?? {};
    await writeJson(
      join(contestantPath, "run.json"),
      runDocument(contestantId, {
        ...base,
        ...runOverride,
        usage: { ...base.usage, ...(runOverride.usage ?? {}) },
        observedVersions: {
          ...base.observedVersions,
          ...(runOverride.observedVersions ?? {}),
        },
      }),
    );
    if (overrides.omitTaskStates !== true) {
      await writeJson(
        join(contestantPath, "task.json"),
        taskDocument(
          "contestant",
          contestantId,
          `${GENERATION_ID}-contestant-${contestantId}`,
          overrides.contestantTaskStatuses?.[contestantId] ?? base.status,
          base.startedAt,
          base.completedAt,
        ),
      );
      await writeJson(
        join(contestantPath, "render-task.json"),
        taskDocument(
          "render",
          contestantId,
          `${GENERATION_ID}-render-${contestantId}`,
          overrides.renderTaskStatuses?.[contestantId] ??
            (base.status === "succeeded" ? "succeeded" : "invalid"),
          base.completedAt,
          "2026-08-30T10:00:12.000Z",
        ),
      );
    }
  }

  const judgePath = join(generationPath, "judging", "judge-a");
  await mkdir(join(judgePath, "tasks"), { recursive: true });
  await mkdir(join(judgePath, "usage"), { recursive: true });
  await mkdir(join(judgePath, "execution-metadata"), { recursive: true });
  if (overrides.omitTimings !== true) {
    await writeJson(
      join(judgePath, "task-timings.json"),
      overrides.timings ?? timingsDocument(),
    );
  }
  await writeJson(
    join(judgePath, "awards.json"),
    GenerationAwardsSchema.parse({
      schemaVersion: 1,
      generationId: GENERATION_ID,
      judgeId: "judge-a",
      awards: [],
    }),
  );
  for (const anonymousCandidateId of ["candidate-aaaa", "candidate-bbbb"]) {
    if (overrides.omitTaskStates !== true) {
      await writeJson(
        join(judgePath, "tasks", `${anonymousCandidateId}.json`),
        taskDocument(
          "judge",
          `judge-a\0${anonymousCandidateId}`,
          `${GENERATION_ID}-judge-judge-a-${anonymousCandidateId}`,
          overrides.judgeTaskStatuses?.[anonymousCandidateId] ?? "succeeded",
          "2026-08-30T10:01:00.000Z",
          "2026-08-30T10:01:05.000Z",
        ),
      );
    }
    await writeJson(
      join(judgePath, "usage", `${anonymousCandidateId}.json`),
      anonymousCandidateId === "candidate-aaaa"
        ? {
            inputTokens: 300,
            outputTokens: 150,
            totalTokens: 450,
            estimatedCostUsd: 0.125,
          }
        : {
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            estimatedCostUsd: 0.0625,
          },
    );
    if (overrides.omitJudgeMetadata !== true) {
      await writeJson(
        join(judgePath, "execution-metadata", `${anonymousCandidateId}.json`),
        metadataDocument(`req-private-${anonymousCandidateId}`),
      );
    }
    const judgment =
      overrides.judgments?.[
        anonymousCandidateId as "candidate-aaaa" | "candidate-bbbb"
      ];
    if (judgment !== undefined) {
      await writeJson(join(judgePath, `${anonymousCandidateId}.json`), judgment);
    }
  }
  if (overrides.omitTaskStates !== true) {
    await writeJson(
      join(judgePath, "awards-task.json"),
      taskDocument(
        "awards",
        "judge-a",
        `${GENERATION_ID}-awards-judge-a`,
        overrides.awardsTaskStatus ?? "succeeded",
        "2026-08-30T10:02:00.000Z",
        "2026-08-30T10:02:01.000Z",
      ),
    );
  }
  await writeJson(join(judgePath, "usage", "awards.json"), {
    inputTokens: 400,
    outputTokens: 200,
    totalTokens: 600,
    estimatedCostUsd: 0.03125,
  });
  if (overrides.omitJudgeMetadata !== true) {
    await writeJson(
      join(judgePath, "execution-metadata", "awards.json"),
      metadataDocument("req-private-awards"),
    );
  }

  for (const [name, value] of Object.entries(overrides.judgeUsage ?? {})) {
    const usagePath = join(judgePath, "usage", `${name}.json`);
    if (value === null) {
      await rm(usagePath, { force: true });
    } else {
      await writeJson(usagePath, value);
    }
  }

  if (overrides.omitLeaderboard !== true) {
    await writeJson(
      join(generationPath, "leaderboard.json"),
      overrides.leaderboard ?? leaderboardDocument(),
    );
  }
  return generationPath;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Tamper with a durable artifact after the happy-path tree is written. */
export async function mutateJson(
  path: string,
  mutate: (value: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeJson(path, mutate(current));
}

export { judgmentDocument };

describe("run summary builder", () => {
  it("sums exact known tokens and cost across contestant and judge calls", async () => {
    const generationPath = await buildDurableGeneration();
    const summary = await buildRunSummary({ generationPath });

    expect(summary.schemaVersion).toBe(1);
    expect(summary.seasonId).toBe(SEASON_ID);
    expect(summary.generationId).toBe(GENERATION_ID);
    expect(summary.generatedAt).toBe(COMPLETED_AT);
    expect(summary.wallClock).toEqual({
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      elapsedMs: 300000,
    });

    // A durable manifest whose completion predates its start (operator clock
    // skew or injected test clocks) is inconsistent evidence: the summary
    // keeps the raw timestamps and reports the derived elapsed as unknown
    // (`null`) rather than fabricating a negative number or failing.
    const skewedPath = await buildDurableGeneration({
      manifest: { startedAt: "2026-08-30T12:00:00.000Z" },
    });
    const skewed = await buildRunSummary({ generationPath: skewedPath });
    expect(skewed.wallClock).toEqual({
      startedAt: "2026-08-30T12:00:00.000Z",
      completedAt: COMPLETED_AT,
      elapsedMs: null,
    });

    expect(summary.totals.inputTokens).toEqual({
      value: 2100,
      completeness: "complete",
    });
    expect(summary.totals.outputTokens).toEqual({
      value: 1050,
      completeness: "complete",
    });
    expect(summary.totals.reasoningTokens).toEqual({
      value: 250,
      completeness: "complete",
    });
    expect(summary.totals.totalTokens).toEqual({
      value: 3150,
      completeness: "complete",
    });
    expect(summary.totals.estimatedCostUsd).toEqual({
      value: 0.96875,
      completeness: "complete",
    });
    expect(summary.totals.callsWithUnknownUsage).toBe(0);
    expect(summary.totals.callsWithUnknownCost).toBe(0);

    expect(summary.configuredMaximumCalls).toBe(5);

    expect(summary.contestants).toEqual([
      {
        contestantId: "contestant-a",
        anonymousCandidateId: "candidate-aaaa",
        durationMs: 5000,
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          reasoningTokens: 200,
          totalTokens: 1500,
        },
        estimatedCostUsd: 0.25,
        versionCompleteness: "complete",
        oneShotEnforcement: "enforced",
      },
      {
        contestantId: "contestant-b",
        anonymousCandidateId: "candidate-bbbb",
        durationMs: 4000,
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          reasoningTokens: 50,
          totalTokens: 300,
        },
        estimatedCostUsd: 0.5,
        versionCompleteness: "complete",
        oneShotEnforcement: "prompt_only",
      },
    ]);

    expect(summary.judges).toEqual([
      {
        judgeId: "judge-a",
        candidateCalls: [
          {
            anonymousCandidateId: "candidate-aaaa",
            durationMs: 3000,
            usage: { inputTokens: 300, outputTokens: 150, totalTokens: 450 },
            estimatedCostUsd: 0.125,
            versionCompleteness: "complete",
          },
          {
            anonymousCandidateId: "candidate-bbbb",
            durationMs: 2000,
            usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
            estimatedCostUsd: 0.0625,
            versionCompleteness: "complete",
          },
        ],
        awardsCall: {
          durationMs: 1000,
          usage: { inputTokens: 400, outputTokens: 200, totalTokens: 600 },
          estimatedCostUsd: 0.03125,
          versionCompleteness: "complete",
        },
      },
    ]);

    // The writer emits canonical bytes and the generated file reparses to the
    // same schema-validated data.
    const bytes = serializeRunSummary(summary);
    expect(bytes).toBe(`${JSON.stringify(summary, null, 2)}\n`);
    await writeRunSummary(generationPath, summary);
    expect(await readFile(join(generationPath, "run-summary.json"), "utf8")).toBe(
      bytes,
    );
  });

  it("labels totals partial and counts unknown usage and cost per call", async () => {
    const generationPath = await buildDurableGeneration({
      contestantRuns: {
        "contestant-b": {
          usage: {
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            totalTokens: null,
            estimatedCostUsd: null,
          },
        },
      },
      judgeUsage: {
        // No durable usage file and no durable judgment for this candidate.
        "candidate-bbbb": null,
        // A durable usage file that is not valid usage data stays unknown.
        awards: "not-json-object",
      },
    });
    const summary = await buildRunSummary({ generationPath });

    expect(summary.totals.inputTokens).toEqual({
      value: 1300,
      completeness: "partial",
    });
    expect(summary.totals.outputTokens).toEqual({
      value: 650,
      completeness: "partial",
    });
    expect(summary.totals.reasoningTokens).toEqual({
      value: 200,
      completeness: "partial",
    });
    expect(summary.totals.totalTokens).toEqual({
      value: 1950,
      completeness: "partial",
    });
    expect(summary.totals.estimatedCostUsd).toEqual({
      value: 0.375,
      completeness: "partial",
    });
    // Unknown usage: contestant-b, candidate-bbbb, and the awards call.
    expect(summary.totals.callsWithUnknownUsage).toBe(3);
    expect(summary.totals.callsWithUnknownCost).toBe(3);

    expect(summary.contestants[1]).toMatchObject({
      contestantId: "contestant-b",
      durationMs: 4000,
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
      },
      estimatedCostUsd: null,
    });
    expect(summary.judges[0]?.candidateCalls[1]).toMatchObject({
      anonymousCandidateId: "candidate-bbbb",
      durationMs: 2000,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      estimatedCostUsd: null,
    });
    expect(summary.judges[0]?.awardsCall.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });

  it("keeps known zero distinct from unknown null and reports version completeness", async () => {
    const generationPath = await buildDurableGeneration({
      contestantRuns: {
        "contestant-a": {
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            estimatedCostUsd: 0,
          },
          observedVersions: { harness: null, model: null },
        },
        "contestant-b": {
          usage: {
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            totalTokens: null,
            estimatedCostUsd: null,
          },
          observedVersions: { harness: "only-harness", model: null },
        },
      },
      judgeUsage: {
        "candidate-aaaa": {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
        },
        "candidate-bbbb": { inputTokens: null, outputTokens: null, totalTokens: null },
        awards: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
        },
      },
      omitJudgeMetadata: true,
    });
    const summary = await buildRunSummary({ generationPath });

    // Known zeros sum to a known zero per field, but contestant-b and
    // candidate-bbbb keep the aggregates partial.
    expect(summary.totals.inputTokens).toEqual({ value: 0, completeness: "partial" });
    expect(summary.totals.estimatedCostUsd).toEqual({
      value: 0,
      completeness: "partial",
    });
    expect(summary.contestants[0]?.usage.inputTokens).toBe(0);
    expect(summary.contestants[1]?.usage.inputTokens).toBeNull();
    expect(summary.judges[0]?.candidateCalls[0]?.usage.totalTokens).toBe(0);
    expect(summary.judges[0]?.candidateCalls[1]?.usage.totalTokens).toBeNull();

    // Version completeness: no observations is "unknown", one of two is
    // "partial", and missing private metadata files are "unknown".
    expect(summary.contestants[0]?.versionCompleteness).toBe("unknown");
    expect(summary.contestants[1]?.versionCompleteness).toBe("partial");
    expect(summary.judges[0]?.candidateCalls[0]?.versionCompleteness).toBe("unknown");
    expect(summary.judges[0]?.awardsCall.versionCompleteness).toBe("unknown");
  });

  it("falls back to durable judgment model usage when the raw usage file is absent", async () => {
    const generationPath = await buildDurableGeneration({
      judgeUsage: { "candidate-aaaa": null },
      judgments: { "candidate-aaaa": judgmentDocument("candidate-aaaa") },
    });
    const summary = await buildRunSummary({ generationPath });

    expect(summary.judges[0]?.candidateCalls[0]).toMatchObject({
      anonymousCandidateId: "candidate-aaaa",
      usage: { inputTokens: 111, outputTokens: 22, totalTokens: 133 },
      estimatedCostUsd: 0.00390625,
    });
  });

  it("counts every task status by role without fabricating unrecorded slots", async () => {
    const generationPath = await buildDurableGeneration({
      contestantTaskStatuses: { "contestant-b": "uncertain" },
      renderTaskStatuses: { "contestant-a": "invalid", "contestant-b": "succeeded" },
      judgeTaskStatuses: { "candidate-bbbb": "missing_submission" },
      awardsTaskStatus: "pending",
    });
    const summary = await buildRunSummary({ generationPath });

    expect(summary.taskCounts).toEqual([
      {
        role: "contestant",
        planned: 2,
        started: 2,
        succeeded: 1,
        failed: 0,
        timeout: 0,
        missingSubmission: 0,
        invalid: 0,
        uncertain: 1,
      },
      {
        role: "render",
        planned: 2,
        started: 2,
        succeeded: 1,
        failed: 0,
        timeout: 0,
        missingSubmission: 0,
        invalid: 1,
        uncertain: 0,
      },
      {
        role: "judge",
        planned: 2,
        started: 2,
        succeeded: 1,
        failed: 0,
        timeout: 0,
        missingSubmission: 1,
        invalid: 0,
        uncertain: 0,
      },
      {
        role: "awards",
        planned: 1,
        started: 0,
        succeeded: 0,
        failed: 0,
        timeout: 0,
        missingSubmission: 0,
        invalid: 0,
        uncertain: 0,
      },
    ]);
  });

  it("reports configured maximum calls from the durable run plan", async () => {
    const generationPath = await buildDurableGeneration();
    const summary = await buildRunSummary({ generationPath });
    expect(summary.configuredMaximumCalls).toBe(5);
  });

  it("derives resource-group concurrency and start-rate observations from durable timestamps", async () => {
    const generationPath = await buildDurableGeneration();
    const summary = await buildRunSummary({ generationPath });

    expect(summary.resourceGroups).toEqual([
      {
        name: "jury",
        configuredMaximumConcurrency: 2,
        configuredMinimumStartIntervalMs: 250,
        observedStartCount: 3,
        observedMaximumConcurrency: 2,
        observedMinimumStartIntervalMs: 2000,
      },
      {
        name: "lane",
        configuredMaximumConcurrency: 2,
        configuredMinimumStartIntervalMs: 500,
        observedStartCount: 2,
        observedMaximumConcurrency: 2,
        observedMinimumStartIntervalMs: 500,
      },
    ]);
  });

  it("keeps resource-group observations null when durable evidence is insufficient", async () => {
    const generationPath = await buildDurableGeneration({
      contestantRuns: {
        "contestant-b": {
          status: "pending",
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    });
    const summary = await buildRunSummary({ generationPath });

    const lane = summary.resourceGroups.find((group) => group.name === "lane");
    expect(lane).toMatchObject({
      observedStartCount: 1,
      observedMaximumConcurrency: 1,
      observedMinimumStartIntervalMs: null,
    });
  });

  it("produces byte-equivalent summaries for identical durable artifacts", async () => {
    const first = await buildDurableGeneration();
    const second = await buildDurableGeneration();
    const firstSummary = serializeRunSummary(
      await buildRunSummary({ generationPath: first }),
    );
    const secondSummary = serializeRunSummary(
      await buildRunSummary({ generationPath: second }),
    );
    expect(firstSummary).toBe(secondSummary);

    // A supplied deterministic timestamp is honoured identically.
    const suppliedA = serializeRunSummary(
      await buildRunSummary({
        generationPath: first,
        generatedAt: "2026-08-31T00:00:00.000Z",
      }),
    );
    const suppliedB = serializeRunSummary(
      await buildRunSummary({
        generationPath: first,
        generatedAt: "2026-08-31T00:00:00.000Z",
      }),
    );
    expect(suppliedA).toBe(suppliedB);
    expect(suppliedA).toContain('"generatedAt": "2026-08-31T00:00:00.000Z"');

    // Writing twice keeps the artifact byte-identical.
    await writeRunSummary(first, await buildRunSummary({ generationPath: first }));
    const written = await readFile(join(first, "run-summary.json"), "utf8");
    await writeRunSummary(first, await buildRunSummary({ generationPath: first }));
    expect(await readFile(join(first, "run-summary.json"), "utf8")).toBe(written);
  });

  it("rejects identity and generation mismatches in durable artifacts", async () => {
    const mismatch = async (
      mutate: (generationPath: string) => Promise<void>,
    ): Promise<void> => {
      const generationPath = await buildDurableGeneration();
      await mutate(generationPath);
      await expect(buildRunSummary({ generationPath })).rejects.toThrow(
        /run summary rejected/iu,
      );
    };

    // Manifest generation ID does not match the generation directory.
    await mismatch(async (path) => {
      await mutateJson(join(path, "manifest.json"), (value) => ({
        ...value,
        generationId: "0002",
      }));
    });
    // Anonymous map refers to another generation.
    await mismatch(async (path) => {
      await mutateJson(join(path, "judging", "anonymous-map.json"), (value) => ({
        ...value,
        generationId: "0002",
      }));
    });
    // Contestant identity carries the wrong anonymous candidate ID.
    await mismatch(async (path) => {
      await mutateJson(
        join(path, "contestants", "contestant-a", "identity.json"),
        (value) => ({ ...value, anonymousCandidateId: "candidate-zzzz" }),
      );
    });
    // Contestant run carries a task ID from another generation.
    await mismatch(async (path) => {
      await mutateJson(
        join(path, "contestants", "contestant-a", "run.json"),
        (value) => ({
          ...value,
          taskId: "0002-contestant-candidate-aaaa",
        }),
      );
    });
    // Task state names the wrong role for its file.
    await mismatch(async (path) => {
      await mutateJson(
        join(path, "contestants", "contestant-a", "task.json"),
        (value) => ({ ...value, role: "render" }),
      );
    });
    // Contestant task state carries a task ID from another generation.
    await mismatch(async (path) => {
      await mutateJson(
        join(path, "contestants", "contestant-a", "task.json"),
        (value) => ({ ...value, taskId: "0002-contestant-contestant-a" }),
      );
    });
    // Judge timings name an anonymous candidate outside the map.
    await mismatch(async (path) => {
      await mutateJson(
        join(path, "judging", "judge-a", "task-timings.json"),
        (value) => ({
          ...value,
          generationId: "0002",
        }),
      );
    });
    const strangerGeneration = await buildDurableGeneration();
    await mutateJson(
      join(strangerGeneration, "judging", "judge-a", "task-timings.json"),
      (value) => ({
        ...value,
        tasks: [
          {
            operation: "candidate",
            anonymousCandidateId: "candidate-zzzz",
            startedAt: "2026-08-30T10:01:00.000Z",
            completedAt: "2026-08-30T10:01:03.000Z",
            durationMs: 3000,
          },
        ],
      }),
    );
    await expect(
      buildRunSummary({ generationPath: strangerGeneration }),
    ).rejects.toThrow(/unknown anonymous candidate/iu);
    // Durable judgment belongs to another judge.
    await mismatch(async (path) => {
      const judgment = judgmentDocument("candidate-aaaa") as Record<string, unknown>;
      await writeJson(join(path, "judging", "judge-a", "candidate-aaaa.json"), {
        ...judgment,
        judgeId: "judge-zz",
      });
    });
    // Awards artifact belongs to another generation.
    await mismatch(async (path) => {
      await mutateJson(join(path, "judging", "judge-a", "awards.json"), (value) => ({
        ...value,
        generationId: "0002",
      }));
    });
    // Run plan belongs to another generation.
    await mismatch(async (path) => {
      await mutateJson(join(path, "run-plan.json"), (value) => ({
        ...value,
        generationId: "0002",
      }));
    });
    // Leaderboard roster does not match the manifest.
    await mismatch(async (path) => {
      await mutateJson(join(path, "leaderboard.json"), (value) => ({
        ...value,
        generationId: "0002",
      }));
    });
    await mismatch(async (path) => {
      const leaderboard = JSON.parse(
        await readFile(join(path, "leaderboard.json"), "utf8"),
      ) as {
        entries: { contestantId: string; screenshotPath: string }[];
      };
      leaderboard.entries[0]!.contestantId = "contestant-zz";
      leaderboard.entries[0]!.screenshotPath =
        "contestants/contestant-zz/screenshot.png";
      await writeJson(join(path, "leaderboard.json"), leaderboard);
    });
  });

  it("reads archived Phase 1 generations without a run plan", async () => {
    const generationPath = await buildDurableGeneration({
      omitRunPlan: true,
      omitTaskStates: true,
      omitTimings: true,
      omitJudgeMetadata: true,
      configVersion: 1,
      contestantRuns: {
        "contestant-a": {
          usage: {
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            totalTokens: null,
            estimatedCostUsd: null,
          },
        },
        "contestant-b": {
          usage: {
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            totalTokens: null,
            estimatedCostUsd: null,
          },
        },
      },
      judgeUsage: { "candidate-aaaa": null, "candidate-bbbb": null, awards: null },
    });
    const summary = await buildRunSummary({ generationPath });

    expect(summary.generationId).toBe(GENERATION_ID);
    expect(summary.configuredMaximumCalls).toBeNull();
    expect(summary.resourceGroups).toEqual([]);
    expect(summary.contestants[0]?.oneShotEnforcement).toBeNull();
    // Phase 1 runs recorded non-null observed versions; they stay complete.
    expect(summary.contestants[0]?.versionCompleteness).toBe("complete");

    // Contestant counts come from durable run statuses; roles without any
    // task-state evidence stay unknown (null) instead of claiming zero.
    const counts = Object.fromEntries(
      summary.taskCounts.map((entry) => [entry.role, entry]),
    );
    expect(counts.contestant).toMatchObject({
      planned: 2,
      started: 2,
      succeeded: 1,
      timeout: 1,
    });
    expect(counts.render).toMatchObject({ planned: 2, started: null, succeeded: null });
    expect(counts.judge).toMatchObject({ planned: 2, started: null, succeeded: null });
    expect(counts.awards).toMatchObject({ planned: 1, started: null, succeeded: null });

    // The two contestant calls attempted with no usage evidence make every
    // token aggregate partial with a known-zero sum, never an inferred value.
    expect(summary.totals.inputTokens).toEqual({ value: 0, completeness: "partial" });
    expect(summary.totals.callsWithUnknownUsage).toBe(3);
    expect(summary.totals.callsWithUnknownCost).toBe(3);
    // The awards call has durable evidence (awards.json), so it counts as
    // attempted with unknown usage; candidate calls have no evidence at all.
    expect(summary.judges[0]?.awardsCall.durationMs).toBeNull();
    expect(summary.judges[0]?.candidateCalls[0]?.versionCompleteness).toBe("unknown");
  });

  it("never copies provider request IDs or other private raw metadata into the summary", async () => {
    const generationPath = await buildDurableGeneration();
    const summary = await buildRunSummary({ generationPath });
    const serialized = serializeRunSummary(summary);

    for (const forbidden of [
      "req-private",
      "providerRequestId",
      "observed-harness",
      "observed-model",
      "stdout.log",
      "stderr.log",
      "/absolute",
      "Contestant A",
      "displayName",
      "prompt.md",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The written private artifact carries the same guarantee.
    await writeRunSummary(generationPath, summary);
    const onDisk = await readFile(join(generationPath, "run-summary.json"), "utf8");
    expect(onDisk).not.toContain("req-private");
    expect(onDisk).not.toContain("providerRequestId");
  });

  it("summarizes a real fixture-orchestrated generation from its durable artifacts", async () => {
    const repositoryRoot = new URL("../../", import.meta.url).pathname;
    const root = await createTestTempRoot("local-maxima-run-summary-e2e-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot: join(root, "generations"),
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-30T10:00:00.000Z",
    });
    await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
    });
    const generationPath = generation.generationPath;

    const summary = await buildRunSummary({ generationPath });
    expect(summary.generationId).toBe("0001");
    expect(summary.seasonId).toBe("0001");
    // The fixture profile plans 3 contestants x 1 call, 3 x 2 candidate
    // calls, and 2 awards calls.
    expect(summary.configuredMaximumCalls).toBe(11);
    // Wave-B leaves completion to the next stage, so the wall clock is
    // started but not completed.
    expect(summary.wallClock.startedAt).not.toBeNull();
    expect(summary.wallClock.completedAt).toBeNull();
    expect(summary.wallClock.elapsedMs).toBeNull();

    expect(summary.contestants.map((entry) => entry.contestantId)).toEqual([
      "fixture-editorial",
      "fixture-generic",
      "fixture-geometric",
    ]);
    for (const contestant of summary.contestants) {
      // Schema-v1 fixture configuration records no one-shot enforcement mode.
      expect(contestant.oneShotEnforcement).toBeNull();
      expect(contestant.durationMs).not.toBeNull();
      // Fixture wrappers report no usage: nulls stay unknown, never zero.
      expect(contestant.usage).toEqual({
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
      });
      expect(contestant.estimatedCostUsd).toBeNull();
      // The deterministic fixture wrappers do report observed versions.
      expect(contestant.versionCompleteness).toBe("complete");
    }

    expect(summary.judges.map((entry) => entry.judgeId)).toEqual([
      "fixture-critic-a",
      "fixture-critic-b",
    ]);
    for (const judge of summary.judges) {
      expect(judge.candidateCalls.map((call) => call.anonymousCandidateId)).toEqual(
        summary.contestants.map((entry) => entry.anonymousCandidateId).sort(),
      );
      for (const call of judge.candidateCalls) {
        expect(call.durationMs).not.toBeNull();
        expect(call.versionCompleteness).toBe("complete");
      }
      expect(judge.awardsCall.durationMs).not.toBeNull();
    }

    // Every one of the eleven real calls reported no usage or cost, so all
    // aggregates are known-zero sums labelled partial.
    expect(summary.totals).toEqual({
      inputTokens: { value: 0, completeness: "partial" },
      outputTokens: { value: 0, completeness: "partial" },
      reasoningTokens: { value: 0, completeness: "partial" },
      totalTokens: { value: 0, completeness: "partial" },
      estimatedCostUsd: { value: 0, completeness: "partial" },
      callsWithUnknownUsage: 11,
      callsWithUnknownCost: 11,
    });

    // Non-resumable Wave-B writes no task-state files: contestant counts
    // come from durable run statuses, other roles stay unknown (null).
    const counts = Object.fromEntries(
      summary.taskCounts.map((entry) => [entry.role, entry]),
    );
    expect(counts.contestant).toMatchObject({
      planned: 3,
      started: 3,
      succeeded: 3,
    });
    expect(counts.render).toMatchObject({ planned: 3, started: null });
    expect(counts.judge).toMatchObject({ planned: 6, started: null });
    expect(counts.awards).toMatchObject({ planned: 2, started: null });
    expect(summary.resourceGroups).toEqual([]);

    // The fixture wrappers write private provider request IDs into durable
    // execution metadata; none may reach the summary.
    const serialized = serializeRunSummary(summary);
    for (const forbidden of ["fixture-request", "providerRequestId", "workspace"]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Rebuilding from the same durable artifacts is byte-identical.
    const rebuilt = serializeRunSummary(await buildRunSummary({ generationPath }));
    expect(rebuilt).toBe(serialized);
  }, 90000);
});
