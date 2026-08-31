import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadGalleryPresentation } from "../../src/gallery/presentation.js";
import {
  AnonymousMapSchema,
  JudgesConfigSchema,
  LeaderboardSchema,
  ManifestSchema,
  RunSchema,
  TaskStateSchema,
  type JudgesConfig,
  type Leaderboard,
  type Manifest,
} from "../../src/schemas/index.js";

const timestamp = "2026-08-31T12:00:00.000Z";
const contestantIds = [
  "contestant-zero",
  "contestant-nonzero",
  "contestant-unknown",
  "contestant-failed",
] as const;
const anonymousIds = [
  "candidate-zero",
  "candidate-nonzero",
  "candidate-unknown",
  "candidate-failed",
] as const;

const matrixContestantIds = [
  "contestant-beta",
  "contestant-alpha",
  "contestant-zeta",
] as const;
const matrixAnonymousIds = [
  "candidate-beta",
  "candidate-alpha",
  "candidate-zeta",
] as const;
const matrixJudgeIds = ["judge-zulu", "judge-alpha"] as const;

const manifest: Manifest = ManifestSchema.parse({
  schemaVersion: 1,
  seasonId: "0001",
  generationId: "0001",
  status: "completed",
  createdAt: timestamp,
  startedAt: timestamp,
  completedAt: timestamp,
  previousGenerationId: null,
  challengeVersion: "1.1.0",
  configHashes: {
    challenge: "a".repeat(64),
    contestants: "b".repeat(64),
    judges: "c".repeat(64),
  },
  environment: {
    os: "darwin",
    architecture: "arm64",
    nodeVersion: "v24.0.0",
    playwrightVersion: "1.55.0",
    chromiumVersion: "140.0.0.0",
  },
  contestantIds: [...contestantIds],
  judgeIds: ["judge-alpha"],
  errors: [],
});

const judgesConfig: JudgesConfig = JudgesConfigSchema.parse({
  schemaVersion: 1,
  defaults: {
    timeoutMs: 180000,
    maximumOutputTokens: 4000,
    concurrencyPerJudge: 2,
  },
  judges: [
    {
      id: "judge-alpha",
      displayName: "Judge Alpha",
      harness: {
        name: "fixture-judge",
        version: "1.0.0",
        adapter: "fixture",
        fixture: "critic-a",
      },
      model: {
        provider: "local-fixture",
        name: "critic-a-model",
        version: "1.0.0",
      },
      budget: { timeoutMs: 180000, maximumOutputTokens: 4000 },
      enabled: true,
    },
  ],
});

const matrixManifest: Manifest = ManifestSchema.parse({
  ...manifest,
  contestantIds: [...matrixContestantIds],
  judgeIds: [...matrixJudgeIds],
});

const matrixJudgesConfig: JudgesConfig = JudgesConfigSchema.parse({
  ...judgesConfig,
  judges: matrixJudgeIds.map((id, index) => ({
    ...judgesConfig.judges[0],
    id,
    displayName: index === 0 ? "Judge Zulu" : "Judge Alpha",
    model: {
      ...judgesConfig.judges[0]!.model,
      name: `${id}-model`,
    },
  })),
});

function leaderboard(): Leaderboard {
  return LeaderboardSchema.parse({
    schemaVersion: 1,
    seasonId: "0001",
    generationId: "0001",
    generatedAt: timestamp,
    rankingMethod: "mean-valid-judge-score-v1",
    expectedJudgeCount: 1,
    entries: contestantIds.map((contestantId, index) => ({
      rank: null,
      contestantId,
      displayName: contestantId,
      harnessName: "fixture-harness",
      modelName: "fixture-model",
      status: index === 3 ? "execution_failed" : "valid",
      screenshotPath: null,
      combinedScore: null,
      medianScore: null,
      originalityScore: null,
      completedJudgeCount: 0,
      expectedJudgeCount: 1,
      judgeScores: [],
      awards: [],
      failure: null,
    })),
  });
}

function runArtifact(
  anonymousCandidateId: string,
  input: {
    readonly status: "succeeded" | "failed";
    readonly durationMs: number | null;
    readonly estimatedCostUsd: number | null;
  },
) {
  return RunSchema.parse({
    schemaVersion: 1,
    taskId: `0001-contestant-${anonymousCandidateId}`,
    status: input.status,
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: input.durationMs,
    exitCode: input.status === "succeeded" ? 0 : 1,
    timedOut: false,
    attemptCount: 1,
    configuredBudget: { timeoutMs: 480000, maximumTotalTokens: 30000 },
    usage: {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      estimatedCostUsd: input.estimatedCostUsd,
      tokenLimitEnforced: false,
    },
    observedVersions: { harness: null, model: null },
    stdoutLog: `logs/${anonymousCandidateId}.stdout.log`,
    stderrLog: `logs/${anonymousCandidateId}.stderr.log`,
    error: null,
  });
}

async function writeFixtureArtifacts(generationPath: string): Promise<void> {
  await mkdir(join(generationPath, "config"), { recursive: true });
  await mkdir(join(generationPath, "judging"), { recursive: true });
  await writeFile(
    join(generationPath, "config/judges.yaml"),
    JSON.stringify(judgesConfig),
    "utf8",
  );
  await writeFile(
    join(generationPath, "judging/anonymous-map.json"),
    `${JSON.stringify(
      AnonymousMapSchema.parse({
        schemaVersion: 1,
        generationId: "0001",
        entries: contestantIds.map((contestantId, index) => ({
          contestantId,
          anonymousCandidateId: anonymousIds[index],
        })),
      }),
    )}\n`,
    "utf8",
  );

  const runs = [
    runArtifact(anonymousIds[0], {
      status: "succeeded",
      durationMs: 0,
      estimatedCostUsd: 0,
    }),
    runArtifact(anonymousIds[1], {
      status: "succeeded",
      durationMs: 1534,
      estimatedCostUsd: 0.01234567,
    }),
    runArtifact(anonymousIds[2], {
      status: "succeeded",
      durationMs: null,
      estimatedCostUsd: null,
    }),
    runArtifact(anonymousIds[3], {
      status: "failed",
      durationMs: 4321,
      estimatedCostUsd: 0.000001,
    }),
  ];
  await Promise.all(
    contestantIds.map(async (contestantId, index) => {
      const contestantPath = join(generationPath, "contestants", contestantId);
      await mkdir(contestantPath, { recursive: true });
      await writeFile(
        join(contestantPath, "run.json"),
        `${JSON.stringify(runs[index])}\n`,
        "utf8",
      );
    }),
  );
}

async function writeMatrixArtifacts(generationPath: string): Promise<void> {
  await mkdir(join(generationPath, "config"), { recursive: true });
  await mkdir(join(generationPath, "judging"), { recursive: true });
  await writeFile(
    join(generationPath, "config/judges.yaml"),
    `${JSON.stringify(matrixJudgesConfig)}\n`,
    "utf8",
  );
  await writeFile(
    join(generationPath, "judging/anonymous-map.json"),
    `${JSON.stringify(
      AnonymousMapSchema.parse({
        schemaVersion: 1,
        generationId: "0001",
        entries: matrixContestantIds
          .map((contestantId, index) => ({
            contestantId,
            anonymousCandidateId: matrixAnonymousIds[index],
          }))
          .reverse(),
      }),
    )}\n`,
    "utf8",
  );
  await Promise.all(
    matrixContestantIds.map(async (contestantId, index) => {
      const contestantPath = join(generationPath, "contestants", contestantId);
      await mkdir(contestantPath, { recursive: true });
      await writeFile(
        join(contestantPath, "run.json"),
        `${JSON.stringify(
          runArtifact(matrixAnonymousIds[index]!, {
            status: "succeeded",
            durationMs: 0,
            estimatedCostUsd: 0,
          }),
        )}\n`,
        "utf8",
      );
    }),
  );

  const taskStates = [
    ["judge-zulu", "candidate-zeta", "invalid"],
    ["judge-alpha", "candidate-zeta", "timeout"],
    ["judge-zulu", "candidate-beta", "timeout"],
    ["judge-zulu", "candidate-alpha", "invalid"],
    ["judge-alpha", "candidate-alpha", "invalid"],
  ] as const;
  await Promise.all(
    taskStates.map(async ([judgeId, anonymousCandidateId, status]) => {
      const taskPath = join(
        generationPath,
        "judging",
        judgeId,
        "tasks",
        `${anonymousCandidateId}.json`,
      );
      await mkdir(join(taskPath, ".."), { recursive: true });
      await writeFile(
        taskPath,
        `${JSON.stringify(
          TaskStateSchema.parse({
            schemaVersion: 1,
            taskId: `0001-judge-${judgeId}-${anonymousCandidateId}`,
            role: "judge",
            targetId: `${judgeId}\0${anonymousCandidateId}`,
            status,
            startedAt: timestamp,
            completedAt: timestamp,
            attemptCount: 1,
            requestAccepted: false,
            error: null,
          }),
        )}\n`,
        "utf8",
      );
    }),
  );
}

function matrixLeaderboardForRankChecks(): Leaderboard {
  return LeaderboardSchema.parse({
    schemaVersion: 1,
    seasonId: "0001",
    generationId: "0001",
    generatedAt: timestamp,
    rankingMethod: "mean-valid-judge-score-v1",
    expectedJudgeCount: 2,
    entries: [
      {
        rank: 1,
        contestantId: "contestant-zeta",
        displayName: "Zeta contestant",
        harnessName: "fixture-harness",
        modelName: "zeta-model",
        status: "judge_incomplete",
        screenshotPath: null,
        combinedScore: 75,
        medianScore: 75,
        originalityScore: 15,
        minimumScore: 75,
        maximumScore: 75,
        scoreRange: 0,
        standardDeviation: 0,
        completedJudgeCount: 1,
        expectedJudgeCount: 2,
        judgeScores: [
          {
            judgeId: "judge-alpha",
            totalScore: 75,
            originalityScore: 15,
            critique: "A clear page.",
          },
        ],
        awards: [],
        failure: null,
      },
      {
        rank: 2,
        contestantId: "contestant-alpha",
        displayName: "Alpha contestant",
        harnessName: "fixture-harness",
        modelName: "alpha-model",
        status: "valid",
        screenshotPath: null,
        combinedScore: 41,
        medianScore: 41,
        originalityScore: 6,
        minimumScore: 0,
        maximumScore: 82,
        scoreRange: 82,
        standardDeviation: 41,
        completedJudgeCount: 2,
        expectedJudgeCount: 2,
        judgeScores: [
          {
            judgeId: "judge-zulu",
            totalScore: 82,
            originalityScore: 12,
            critique: "A clear page.",
          },
          {
            judgeId: "judge-alpha",
            totalScore: 0,
            originalityScore: 0,
            critique: "A clear page.",
          },
        ],
        awards: [],
        failure: null,
      },
      {
        rank: null,
        contestantId: "contestant-beta",
        displayName: "Beta contestant",
        harnessName: "fixture-harness",
        modelName: "beta-model",
        status: "execution_failed",
        screenshotPath: null,
        combinedScore: null,
        medianScore: null,
        originalityScore: null,
        scoreRange: null,
        completedJudgeCount: 0,
        expectedJudgeCount: 2,
        judgeScores: [],
        awards: [],
        failure: "private task error must not be projected",
      },
    ],
  });
}

describe("gallery presentation", () => {
  it("formats only allowlisted contestant runtime and cost labels", async () => {
    const generationPath = await mkdtemp(join(tmpdir(), "local-maxima-presentation-"));
    await writeFixtureArtifacts(generationPath);

    const presentation = await loadGalleryPresentation({
      generationPath,
      manifest,
      leaderboard: leaderboard(),
      judgesConfig,
    });

    expect([...presentation.operationalLabelsByContestant.entries()]).toEqual([
      [
        "contestant-zero",
        { runtimeLabel: "0.00 s", estimatedCostLabel: "USD 0.000000" },
      ],
      [
        "contestant-nonzero",
        { runtimeLabel: "1.53 s", estimatedCostLabel: "USD 0.012346" },
      ],
      ["contestant-unknown", { runtimeLabel: "—", estimatedCostLabel: "—" }],
      [
        "contestant-failed",
        { runtimeLabel: "4.32 s", estimatedCostLabel: "USD 0.000001" },
      ],
    ]);
    expect(JSON.stringify(presentation)).not.toContain("partial");
    expect(JSON.stringify(presentation)).not.toMatch(
      /inputTokens|outputTokens|reasoningTokens|totalTokens|request|error|prompt|log/iu,
    );
  });

  it("projects configured judge columns and distinct cell outcomes without ranking", async () => {
    const generationPath = await mkdtemp(
      join(tmpdir(), "local-maxima-presentation-matrix-"),
    );
    await writeMatrixArtifacts(generationPath);
    const matrixLeaderboard = LeaderboardSchema.parse({
      schemaVersion: 1,
      seasonId: "0001",
      generationId: "0001",
      generatedAt: timestamp,
      rankingMethod: "mean-valid-judge-score-v1",
      expectedJudgeCount: 2,
      entries: [
        {
          rank: 1,
          contestantId: "contestant-zeta",
          displayName: "Zeta contestant",
          harnessName: "fixture-harness",
          modelName: "zeta-model",
          status: "judge_incomplete",
          screenshotPath: null,
          combinedScore: 75,
          medianScore: 75,
          originalityScore: 15,
          minimumScore: 75,
          maximumScore: 75,
          scoreRange: 0,
          standardDeviation: 0,
          completedJudgeCount: 1,
          expectedJudgeCount: 2,
          judgeScores: [
            {
              judgeId: "judge-alpha",
              totalScore: 75,
              originalityScore: 15,
              critique: "A clear page. More contrast would sharpen it.",
            },
          ],
          awards: [],
          failure: null,
        },
        {
          rank: 2,
          contestantId: "contestant-alpha",
          displayName: "Alpha contestant",
          harnessName: "fixture-harness",
          modelName: "alpha-model",
          status: "valid",
          screenshotPath: null,
          combinedScore: 41,
          medianScore: 41,
          originalityScore: 6,
          minimumScore: 0,
          maximumScore: 82,
          scoreRange: 82,
          standardDeviation: 41,
          completedJudgeCount: 2,
          expectedJudgeCount: 2,
          judgeScores: [
            {
              judgeId: "judge-zulu",
              totalScore: 82,
              originalityScore: 12,
              critique: "A clear page. More contrast would sharpen it.",
            },
            {
              judgeId: "judge-alpha",
              totalScore: 0,
              originalityScore: 0,
              critique: "A clear page. More contrast would sharpen it.",
            },
          ],
          awards: [],
          failure: null,
        },
        {
          rank: null,
          contestantId: "contestant-beta",
          displayName: "Beta contestant",
          harnessName: "fixture-harness",
          modelName: "beta-model",
          status: "execution_failed",
          screenshotPath: null,
          combinedScore: null,
          medianScore: null,
          originalityScore: null,
          scoreRange: null,
          completedJudgeCount: 0,
          expectedJudgeCount: 2,
          judgeScores: [],
          awards: [],
          failure: "private task error must not be projected",
        },
      ],
    });

    const presentation = await loadGalleryPresentation({
      generationPath,
      manifest: matrixManifest,
      leaderboard: matrixLeaderboard,
      judgesConfig: matrixJudgesConfig,
    });

    expect(presentation.judgeMatrix.columns).toEqual([
      { judgeId: "judge-zulu", displayName: "Judge Zulu" },
      { judgeId: "judge-alpha", displayName: "Judge Alpha" },
    ]);
    expect(presentation.judgeMatrix.rows.map((row) => row.contestantId)).toEqual([
      "contestant-zeta",
      "contestant-alpha",
      "contestant-beta",
    ]);
    expect(presentation.judgeMatrix.rows[0]).toMatchObject({
      rowHeader: "1 · Zeta contestant",
      cells: [
        { judgeId: "judge-zulu", state: "invalid", label: "Invalid" },
        { judgeId: "judge-alpha", state: "score", label: "75" },
      ],
      combinedScoreLabel: "75.00",
      scoreRangeLabel: "0.00",
    });
    expect(presentation.judgeMatrix.rows[2]?.cells).toEqual([
      { judgeId: "judge-zulu", state: "timed_out", label: "Timed out" },
      { judgeId: "judge-alpha", state: "missing", label: "Missing" },
    ]);
    expect(presentation.judgeMatrix.rows[1]).toMatchObject({
      cells: [
        { judgeId: "judge-zulu", state: "score", label: "82" },
        { judgeId: "judge-alpha", state: "score", label: "0" },
      ],
      combinedScoreLabel: "41.00",
      scoreRangeLabel: "82.00",
    });

    const malformedOrder = LeaderboardSchema.parse({
      ...matrixLeaderboard,
      entries: [
        matrixLeaderboard.entries[0]!,
        matrixLeaderboard.entries[2]!,
        matrixLeaderboard.entries[1]!,
      ],
    });
    await expect(
      loadGalleryPresentation({
        generationPath,
        manifest: matrixManifest,
        leaderboard: malformedOrder,
        judgesConfig: matrixJudgesConfig,
      }),
    ).rejects.toThrow(/rank|order|unranked/i);
  });

  it("rejects leaderboard aggregates that contradict the supplied judge totals", async () => {
    const generationPath = await mkdtemp(
      join(tmpdir(), "local-maxima-presentation-aggregate-mismatch-"),
    );
    await writeMatrixArtifacts(generationPath);
    const base = matrixLeaderboardForRankChecks();
    const mismatched = LeaderboardSchema.parse({
      ...base,
      entries: [
        { ...base.entries[0]!, combinedScore: 74 },
        base.entries[1]!,
        base.entries[2]!,
      ],
    });

    await expect(
      loadGalleryPresentation({
        generationPath,
        manifest: matrixManifest,
        leaderboard: mismatched,
        judgesConfig: matrixJudgesConfig,
      }),
    ).rejects.toThrow(/combined|mean|aggregate|evidence/i);
  });

  it.each([
    ["medianScore", 74],
    ["originalityScore", 14],
    ["minimumScore", 74],
    ["maximumScore", 76],
    ["scoreRange", 1],
    ["standardDeviation", 1],
  ] as const)("rejects a contradictory %s aggregate", async (field, value) => {
    const generationPath = await mkdtemp(
      join(tmpdir(), "local-maxima-presentation-aggregate-field-mismatch-"),
    );
    await writeMatrixArtifacts(generationPath);
    const base = matrixLeaderboardForRankChecks();
    const mismatched = LeaderboardSchema.parse({
      ...base,
      entries: [
        { ...base.entries[0]!, [field]: value },
        base.entries[1]!,
        base.entries[2]!,
      ],
    });

    await expect(
      loadGalleryPresentation({
        generationPath,
        manifest: matrixManifest,
        leaderboard: mismatched,
        judgesConfig: matrixJudgesConfig,
      }),
    ).rejects.toThrow(/aggregate|evidence|score/i);
  });

  it.each(["dimensionMeans", "meanHierarchyAndReadability"] as const)(
    "rejects contradictory %s when dimension score evidence is present",
    async (field) => {
      const generationPath = await mkdtemp(
        join(tmpdir(), "local-maxima-presentation-dimension-mismatch-"),
      );
      await writeMatrixArtifacts(generationPath);
      const base = matrixLeaderboardForRankChecks();
      const dimensions = {
        hierarchyAndReadability: 12,
        composition: 12,
        typography: 11,
        colourAndVisualSystem: 8,
        coherenceAndCraft: 12,
        originalityAndMemorability: 15,
        constraintAndCssCraft: 5,
      } as const;
      const zeta = base.entries[0]!;
      const evidenceEntry = {
        ...zeta,
        judgeScores: [{ ...zeta.judgeScores[0]!, scores: dimensions }],
        dimensionMeans:
          field === "dimensionMeans" ? { ...dimensions, composition: 11 } : dimensions,
        meanHierarchyAndReadability: field === "meanHierarchyAndReadability" ? 11 : 12,
      };
      const mismatched = LeaderboardSchema.parse({
        ...base,
        entries: [evidenceEntry, base.entries[1]!, base.entries[2]!],
      });

      await expect(
        loadGalleryPresentation({
          generationPath,
          manifest: matrixManifest,
          leaderboard: mismatched,
          judgesConfig: matrixJudgesConfig,
        }),
      ).rejects.toThrow(/dimension|hierarchy|evidence/i);
    },
  );

  it("accepts archived rankable entries when optional aggregate evidence is absent", async () => {
    const generationPath = await mkdtemp(
      join(tmpdir(), "local-maxima-presentation-legacy-aggregates-"),
    );
    await writeMatrixArtifacts(generationPath);
    const base = matrixLeaderboardForRankChecks();
    const legacyEntries = base.entries.map((entry) => {
      const legacyEntry = { ...entry };
      delete legacyEntry.minimumScore;
      delete legacyEntry.maximumScore;
      delete legacyEntry.scoreRange;
      delete legacyEntry.standardDeviation;
      delete legacyEntry.meanHierarchyAndReadability;
      delete legacyEntry.dimensionMeans;
      return legacyEntry;
    });
    const legacy = LeaderboardSchema.parse({ ...base, entries: legacyEntries });

    const presentation = await loadGalleryPresentation({
      generationPath,
      manifest: matrixManifest,
      leaderboard: legacy,
      judgesConfig: matrixJudgesConfig,
    });
    expect(presentation.judgeMatrix.rows[0]?.combinedScoreLabel).toBe("75.00");
  });

  it("rejects rank order that inverts the official score comparator", async () => {
    const generationPath = await mkdtemp(
      join(tmpdir(), "local-maxima-presentation-ranking-mismatch-"),
    );
    await writeMatrixArtifacts(generationPath);
    const base = matrixLeaderboardForRankChecks();
    const inverted = LeaderboardSchema.parse({
      ...base,
      entries: [
        { ...base.entries[1]!, rank: 1 },
        { ...base.entries[0]!, rank: 2 },
        base.entries[2]!,
      ],
    });

    await expect(
      loadGalleryPresentation({
        generationPath,
        manifest: matrixManifest,
        leaderboard: inverted,
        judgesConfig: matrixJudgesConfig,
      }),
    ).rejects.toThrow(/official comparator|rank|order/i);
  });

  it.each(["hierarchy", "contestant ID"] as const)(
    "rejects equal-score rank order that inverts the %s tie-break",
    async (tieBreak) => {
      const generationPath = await mkdtemp(
        join(tmpdir(), "local-maxima-presentation-tie-break-mismatch-"),
      );
      await writeMatrixArtifacts(generationPath);
      const base = matrixLeaderboardForRankChecks();
      const zeta = base.entries[0]!;
      const alpha = base.entries[1]!;
      const equalAlpha = {
        ...alpha,
        judgeScores: alpha.judgeScores.map((score) => ({
          ...score,
          totalScore: 75,
          originalityScore: 15,
        })),
        combinedScore: 75,
        medianScore: 75,
        originalityScore: 15,
        minimumScore: 75,
        maximumScore: 75,
        scoreRange: 0,
        standardDeviation: 0,
        completedJudgeCount: alpha.judgeScores.length,
        ...(tieBreak === "hierarchy" ? { meanHierarchyAndReadability: 13 } : {}),
      };
      const equalZeta = {
        ...zeta,
        ...(tieBreak === "hierarchy" ? { meanHierarchyAndReadability: 12 } : {}),
      };
      const inverted = LeaderboardSchema.parse({
        ...base,
        entries: [
          { ...equalZeta, rank: 1 },
          { ...equalAlpha, rank: 2 },
          base.entries[2]!,
        ],
      });

      await expect(
        loadGalleryPresentation({
          generationPath,
          manifest: matrixManifest,
          leaderboard: inverted,
          judgesConfig: matrixJudgesConfig,
        }),
      ).rejects.toThrow(/official comparator|rank|order/i);
    },
  );

  it("rejects a scored rankable entry with a null rank", async () => {
    const generationPath = await mkdtemp(
      join(tmpdir(), "local-maxima-presentation-null-rank-"),
    );
    await writeMatrixArtifacts(generationPath);
    const base = matrixLeaderboardForRankChecks();
    const rankless = LeaderboardSchema.parse({
      ...base,
      entries: [
        base.entries[0]!,
        { ...base.entries[1]!, rank: null },
        base.entries[2]!,
      ],
    });

    await expect(
      loadGalleryPresentation({
        generationPath,
        manifest: matrixManifest,
        leaderboard: rankless,
        judgesConfig: matrixJudgesConfig,
      }),
    ).rejects.toThrow(/rank|score|eligible/i);
  });

  it("rejects a ranked entry without rankable score evidence", async () => {
    const generationPath = await mkdtemp(
      join(tmpdir(), "local-maxima-presentation-ranked-without-score-"),
    );
    await writeMatrixArtifacts(generationPath);
    const base = matrixLeaderboardForRankChecks();
    const rankedWithoutScore = LeaderboardSchema.parse({
      ...base,
      entries: [
        { ...base.entries[2]!, rank: 1, status: "valid" },
        { ...base.entries[0]!, rank: 2 },
        { ...base.entries[1]!, rank: 3 },
      ],
    });

    await expect(
      loadGalleryPresentation({
        generationPath,
        manifest: matrixManifest,
        leaderboard: rankedWithoutScore,
        judgesConfig: matrixJudgesConfig,
      }),
    ).rejects.toThrow(/rank|score|eligible/i);
  });

  it.each(["invalid", "timeout"] as const)(
    "preserves a valid leaderboard score ahead of a %s task state",
    async (taskStatus) => {
      const generationPath = await mkdtemp(
        join(tmpdir(), "local-maxima-presentation-score-precedence-"),
      );
      await writeMatrixArtifacts(generationPath);
      await writeFile(
        join(generationPath, "judging/judge-alpha/tasks/candidate-zeta.json"),
        `${JSON.stringify(
          TaskStateSchema.parse({
            schemaVersion: 1,
            taskId: "0001-judge-judge-alpha-candidate-zeta",
            role: "judge",
            targetId: "judge-alpha\0candidate-zeta",
            status: taskStatus,
            startedAt: timestamp,
            completedAt: timestamp,
            attemptCount: 1,
            requestAccepted: false,
            error: null,
          }),
          null,
          2,
        )}\n`,
        "utf8",
      );

      const presentation = await loadGalleryPresentation({
        generationPath,
        manifest: matrixManifest,
        leaderboard: matrixLeaderboardForRankChecks(),
        judgesConfig: matrixJudgesConfig,
      });

      expect(presentation.judgeMatrix.rows[0]?.cells[1]).toEqual({
        judgeId: "judge-alpha",
        state: "score",
        label: "75",
      });
    },
  );

  it("rejects symlinked private artifact parent directories", async () => {
    const generationPath = await mkdtemp(
      join(tmpdir(), "local-maxima-presentation-symlink-"),
    );
    await writeFixtureArtifacts(generationPath);
    const outsidePath = await mkdtemp(
      join(tmpdir(), "local-maxima-presentation-outside-"),
    );
    await mkdir(join(generationPath, "judging/judge-alpha"), { recursive: true });
    await symlink(
      outsidePath,
      join(generationPath, "judging/judge-alpha/tasks"),
      "dir",
    );

    await expect(
      loadGalleryPresentation({
        generationPath,
        manifest,
        leaderboard: leaderboard(),
        judgesConfig,
      }),
    ).rejects.toThrow(/symbolic link|symlink/i);
  });
});
