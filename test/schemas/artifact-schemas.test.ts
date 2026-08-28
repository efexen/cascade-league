import { describe, expect, it } from "vitest";
import {
  CandidateJudgmentSchema,
  JudgeCandidateResponseSchema,
  GenerationAwardsSchema,
  IdentitySchema,
  LeaderboardSchema,
  ManifestSchema,
  RunSchema,
  SnapshotSchema,
  TaskStateSchema,
  ValidationSchema,
  createGenerationAwardsSchema,
} from "../../src/schemas/index.js";

const hash = "a".repeat(64);
const timestamp = "2026-08-27T20:00:00.000Z";
const candidateId = "candidate-k7m4";

const scores = {
  hierarchyAndReadability: 13,
  composition: 12,
  typography: 12,
  colourAndVisualSystem: 8,
  coherenceAndCraft: 12,
  originalityAndMemorability: 17,
  constraintAndCssCraft: 8,
} as const;

const judgment = {
  schemaVersion: 1,
  generationId: "0001",
  judgeId: "fixture-judge",
  anonymousCandidateId: candidateId,
  scores,
  totalScore: 82,
  critique:
    "Clear hierarchy and a confident palette. The lower notes recede too far; strengthen their contrast next.",
  strongestQuality: "Clear hierarchy",
  primaryWeakness: "Quiet lower notes",
  nextMove: "Increase lower-note contrast",
  confidence: "medium",
  flags: [],
  modelUsage: {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    estimatedCostUsd: null,
  },
} as const;

describe("artifact schemas", () => {
  it("accepts explicit resumable task states and terminal outcomes", () => {
    const task = {
      schemaVersion: 1,
      taskId: "0001-contestant-candidate-k7m4",
      role: "contestant",
      targetId: candidateId,
      status: "running",
      startedAt: timestamp,
      completedAt: null,
      attemptCount: 1,
      requestAccepted: null,
      error: null,
    } as const;
    expect(TaskStateSchema.parse(task)).toEqual(task);
    expect(
      TaskStateSchema.parse({
        ...task,
        status: "uncertain",
        completedAt: "2026-08-27T20:01:00.000Z",
        error: "interrupted while the task was running",
      }),
    ).toBeTruthy();
  });

  it("accepts the documented manifest, snapshot, identity, run, and validation shapes", () => {
    expect(
      ManifestSchema.parse({
        schemaVersion: 1,
        seasonId: "0001",
        generationId: "0001",
        status: "created",
        createdAt: timestamp,
        startedAt: null,
        completedAt: null,
        previousGenerationId: null,
        challengeVersion: "1.0.0",
        configHashes: { challenge: hash, contestants: hash, judges: hash },
        environment: {
          os: "macOS",
          architecture: "arm64",
          nodeVersion: "24.6.0",
          playwrightVersion: "1.55.0",
          chromiumVersion: "140.0.7339.16",
        },
        contestantIds: ["fixture-contestant", "second-contestant"],
        judgeIds: ["fixture-judge"],
        errors: [],
      }),
    ).toBeTruthy();

    expect(
      SnapshotSchema.parse({
        schemaVersion: 1,
        sourceTemplate: "challenge/season-001/challenge.hbs",
        dataSource: {
          kind: "seed",
          generationId: null,
          path: "challenge/season-001/seed/seed-generation.json",
        },
        resolvedHtmlPath: "challenge/challenge.html",
        resolvedHtmlSha256: hash,
        inputHashes: {
          "challenge/season-001/challenge.hbs": hash,
        },
        assetHashes: { "thumbnails/seed-01.png": hash },
      }),
    ).toBeTruthy();

    expect(
      IdentitySchema.parse({
        schemaVersion: 1,
        contestantId: "fixture-contestant",
        anonymousCandidateId: candidateId,
        displayName: "Fixture Contestant",
        harness: { name: "fixture-harness", configuredVersion: "1.0.0" },
        model: {
          provider: "fixture-provider",
          name: "fixture-model",
          configuredVersion: "1.0.0",
          reasoningEffort: "medium",
        },
      }),
    ).toBeTruthy();

    expect(
      RunSchema.parse({
        schemaVersion: 1,
        taskId: "0001-contestant-candidate-k7m4",
        status: "succeeded",
        startedAt: timestamp,
        completedAt: "2026-08-27T20:03:41.000Z",
        durationMs: 161000,
        exitCode: 0,
        timedOut: false,
        attemptCount: 1,
        configuredBudget: { timeoutMs: 480000, maximumTotalTokens: 30000 },
        usage: {
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          totalTokens: null,
          estimatedCostUsd: null,
          tokenLimitEnforced: false,
        },
        observedVersions: { harness: "1.0.0", model: "1.0.0" },
        stdoutLog: "logs/contestant-candidate-k7m4.stdout.log",
        stderrLog: "logs/contestant-candidate-k7m4.stderr.log",
        error: null,
      }),
    ).toBeTruthy();

    expect(
      ValidationSchema.parse({
        schemaVersion: 1,
        status: "valid",
        submissionSha256: hash,
        sanitisedSha256: hash,
        submissionBytes: 18342,
        staticChecks: [
          { code: "css_parse", status: "passed", message: "CSS parsed successfully" },
        ],
        renderChecks: [
          {
            code: "horizontal_overflow",
            status: "passed",
            value: 0,
            message: "No horizontal overflow",
          },
        ],
        errors: [],
        warnings: [],
      }),
    ).toBeTruthy();
  });

  it("enforces score maxima, exact totals, critique length, and strict keys", () => {
    expect(CandidateJudgmentSchema.parse(judgment)).toEqual(judgment);
    expect(
      IdentitySchema.parse({
        schemaVersion: 1,
        contestantId: "fixture-contestant",
        anonymousCandidateId: candidateId,
        displayName: "Fixture Contestant",
        harness: { name: "fixture-harness", configuredVersion: "1.0.0" },
        model: {
          provider: "fixture-provider",
          name: "fixture-model",
          configuredVersion: "1.0.0",
          reasoningEffort: "max",
        },
      }),
    ).toBeTruthy();
    expect(() =>
      CandidateJudgmentSchema.parse({
        ...judgment,
        scores: { ...scores, originalityAndMemorability: 21 },
      }),
    ).toThrow();
    expect(() =>
      CandidateJudgmentSchema.parse({ ...judgment, totalScore: 81 }),
    ).toThrow();
    expect(() =>
      CandidateJudgmentSchema.parse({ ...judgment, critique: "x".repeat(501) }),
    ).toThrow();
    expect(() =>
      CandidateJudgmentSchema.parse({ ...judgment, critique: "Only one sentence." }),
    ).toThrow();
    expect(() =>
      CandidateJudgmentSchema.parse({ ...judgment, unexpected: true }),
    ).toThrow();
    expect(() =>
      ManifestSchema.parse({
        schemaVersion: 1,
        seasonId: "0001",
        generationId: "0001",
        status: "created",
        createdAt: "2026-08-27T20:00:00+01:00",
        startedAt: null,
        completedAt: null,
        previousGenerationId: null,
        challengeVersion: "1.0.0",
        configHashes: { challenge: hash, contestants: hash, judges: hash },
        environment: {
          os: "macOS",
          architecture: "arm64",
          nodeVersion: "24.6.0",
          playwrightVersion: "1.55.0",
          chromiumVersion: "140.0.7339.16",
        },
        contestantIds: [],
        judgeIds: [],
        errors: [],
      }),
    ).toThrow();
  });

  it("keeps adapter-measured usage out of the exact judge response schema", () => {
    const response = { ...judgment };
    const { modelUsage, ...modelResponse } = response;
    expect(modelUsage).toBeDefined();
    expect(JudgeCandidateResponseSchema.parse(modelResponse)).toEqual(modelResponse);
    expect(() => JudgeCandidateResponseSchema.parse(response)).toThrow();
  });

  it("bounds awards and rejects an unknown anonymous candidate with contextual validation", () => {
    const awards = {
      schemaVersion: 1,
      generationId: "0001",
      judgeId: "fixture-judge",
      awards: [
        {
          label: "Best Editorial Rhythm",
          anonymousCandidateId: candidateId,
          rationale: "The page establishes a memorable rhythm across its sections.",
        },
      ],
    } as const;
    expect(GenerationAwardsSchema.parse(awards)).toEqual(awards);
    expect(createGenerationAwardsSchema([candidateId]).parse(awards)).toEqual(awards);
    expect(() =>
      createGenerationAwardsSchema(["candidate-other"]).parse(awards),
    ).toThrow();
    expect(() =>
      GenerationAwardsSchema.parse({
        ...awards,
        awards: Array.from({ length: 4 }, (_, index) => ({
          ...awards.awards[0],
          label: `Award Number ${index + 1}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      GenerationAwardsSchema.parse({
        ...awards,
        awards: [{ ...awards.awards[0], label: "One" }],
      }),
    ).toThrow();
    expect(() =>
      GenerationAwardsSchema.parse({
        ...awards,
        awards: [
          { ...awards.awards[0], rationale: "First sentence. Second sentence." },
        ],
      }),
    ).toThrow();
  });

  it("rejects duplicate leaderboard contestants while accepting nullable failure scores", () => {
    const entry = {
      rank: 1,
      contestantId: "fixture-contestant",
      displayName: "Fixture Contestant",
      harnessName: "fixture-harness",
      modelName: "fixture-model",
      status: "valid",
      screenshotPath: "contestants/fixture-contestant/screenshot.png",
      combinedScore: 82.67,
      medianScore: 82,
      originalityScore: 17.33,
      completedJudgeCount: 1,
      expectedJudgeCount: 1,
      judgeScores: [
        {
          judgeId: "fixture-judge",
          totalScore: 82,
          originalityScore: 17,
          critique: judgment.critique,
        },
      ],
      awards: [],
      failure: null,
    } as const;
    const leaderboard = {
      schemaVersion: 1,
      seasonId: "0001",
      generationId: "0001",
      generatedAt: timestamp,
      rankingMethod: "mean-valid-judge-score-v1",
      expectedJudgeCount: 1,
      entries: [
        entry,
        {
          ...entry,
          rank: null,
          status: "timeout",
          contestantId: "second-contestant",
          combinedScore: null,
          medianScore: null,
          originalityScore: null,
          screenshotPath: null,
          completedJudgeCount: 0,
          judgeScores: [],
          failure: "timed out",
        },
      ],
    } as const;
    expect(LeaderboardSchema.parse(leaderboard)).toEqual(leaderboard);
    expect(() =>
      LeaderboardSchema.parse({
        ...leaderboard,
        entries: [{ ...entry, combinedScore: -1 }],
      }),
    ).toThrow();
    expect(() =>
      LeaderboardSchema.parse({ ...leaderboard, entries: [entry, entry] }),
    ).toThrow();
  });

  it("requires each leaderboard screenshot to belong to its contestant", () => {
    const leaderboard = {
      schemaVersion: 1,
      seasonId: "0001",
      generationId: "0001",
      generatedAt: timestamp,
      rankingMethod: "mean-valid-judge-score-v1",
      expectedJudgeCount: 1,
      entries: [
        {
          rank: 1,
          contestantId: "fixture-contestant",
          displayName: "Fixture Contestant",
          harnessName: "fixture-harness",
          modelName: "fixture-model",
          status: "valid" as const,
          screenshotPath: "contestants/other-contestant/screenshot.png",
          combinedScore: 82,
          medianScore: 82,
          originalityScore: 17,
          completedJudgeCount: 1,
          expectedJudgeCount: 1,
          judgeScores: [],
          awards: [],
          failure: null,
        },
      ],
    };

    expect(() => LeaderboardSchema.parse(leaderboard)).toThrow();
  });

  it("rejects private and non-public screenshot paths", () => {
    const baseEntry = {
      rank: 1,
      contestantId: "fixture-contestant",
      displayName: "Fixture Contestant",
      harnessName: "fixture-harness",
      modelName: "fixture-model",
      status: "valid" as const,
      screenshotPath: "contestants/fixture-contestant/screenshot.png",
      combinedScore: 82,
      medianScore: 82,
      originalityScore: 17,
      completedJudgeCount: 1,
      expectedJudgeCount: 1,
      judgeScores: [],
      awards: [],
      failure: null,
    };
    const baseLeaderboard = {
      schemaVersion: 1,
      seasonId: "0001",
      generationId: "0001",
      generatedAt: timestamp,
      rankingMethod: "mean-valid-judge-score-v1",
      expectedJudgeCount: 1,
      entries: [baseEntry],
    };

    expect(() =>
      LeaderboardSchema.parse({
        ...baseLeaderboard,
        entries: [{ ...baseEntry, screenshotPath: "judging/anonymous-map.json" }],
      }),
    ).toThrow();
    expect(() =>
      LeaderboardSchema.parse({
        ...baseLeaderboard,
        entries: [
          { ...baseEntry, screenshotPath: "contestants/fixture-contestant/image.jpg" },
        ],
      }),
    ).toThrow();
    expect(() =>
      LeaderboardSchema.parse({
        ...baseLeaderboard,
        entries: [
          {
            ...baseEntry,
            screenshotPath: "contestants/fixture-contestant/thumbnail.png",
          },
        ],
      }),
    ).toThrow();
    expect(
      LeaderboardSchema.parse({
        ...baseLeaderboard,
        entries: [{ ...baseEntry, screenshotPath: null }],
      }).entries[0]?.screenshotPath,
    ).toBeNull();
  });

  it("requires a strict input hash map on every snapshot", () => {
    expect(() =>
      SnapshotSchema.parse({
        schemaVersion: 1,
        sourceTemplate: "challenge/season-001/challenge.hbs",
        dataSource: {
          kind: "seed",
          generationId: null,
          path: "challenge/season-001/seed/seed-generation.json",
        },
        resolvedHtmlPath: "challenge/challenge.html",
        resolvedHtmlSha256: hash,
        assetHashes: { "thumbnails/seed-01.png": hash },
      }),
    ).toThrow();
  });

  it("rejects zero configured run budgets", () => {
    const run = {
      schemaVersion: 1,
      taskId: "0001-contestant-candidate-k7m4",
      status: "pending" as const,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      exitCode: null,
      timedOut: false,
      attemptCount: 0,
      configuredBudget: { timeoutMs: 0, maximumTotalTokens: 0 },
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        estimatedCostUsd: null,
        tokenLimitEnforced: false,
      },
      observedVersions: { harness: "1.0.0", model: "1.0.0" },
      stdoutLog: "logs/contestant-candidate-k7m4.stdout.log",
      stderrLog: "logs/contestant-candidate-k7m4.stderr.log",
      error: null,
    };

    expect(() => RunSchema.parse(run)).toThrow();
  });

  it("rejects leaderboard entries with more completed judges than expected", () => {
    const entry = {
      rank: 1,
      contestantId: "fixture-contestant",
      displayName: "Fixture Contestant",
      harnessName: "fixture-harness",
      modelName: "fixture-model",
      status: "valid" as const,
      screenshotPath: "contestants/fixture-contestant/screenshot.png",
      combinedScore: 82,
      medianScore: 82,
      originalityScore: 17,
      completedJudgeCount: 2,
      expectedJudgeCount: 1,
      judgeScores: [],
      awards: [],
      failure: null,
    };
    expect(() =>
      LeaderboardSchema.parse({
        schemaVersion: 1,
        seasonId: "0001",
        generationId: "0001",
        generatedAt: timestamp,
        rankingMethod: "mean-valid-judge-score-v1",
        expectedJudgeCount: 1,
        entries: [entry],
      }),
    ).toThrow();
  });
});
