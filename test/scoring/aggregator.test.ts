import { describe, expect, it } from "vitest";

import { ScoreAggregator, serializeLeaderboard } from "../../src/scoring/aggregator.js";
import type { JudgmentScores } from "../../src/schemas/index.js";

const candidateId = "candidate-abcd";

type ScoreOverrides = Partial<{
  hierarchyAndReadability: number;
  composition: number;
  typography: number;
  colourAndVisualSystem: number;
  coherenceAndCraft: number;
  originalityAndMemorability: number;
  constraintAndCssCraft: number;
}>;

function judgment(
  judgeId: string,
  total: number,
  originality: number,
  anonymousId = candidateId,
) {
  const remaining = {
    80: {
      hierarchyAndReadability: 12,
      composition: 12,
      typography: 10,
      colourAndVisualSystem: 8,
      coherenceAndCraft: 14,
      constraintAndCssCraft: 10,
    },
    90: {
      hierarchyAndReadability: 13,
      composition: 14,
      typography: 11,
      colourAndVisualSystem: 9,
      coherenceAndCraft: 15,
      constraintAndCssCraft: 10,
    },
    100: {
      hierarchyAndReadability: 15,
      composition: 15,
      typography: 15,
      colourAndVisualSystem: 10,
      coherenceAndCraft: 15,
      constraintAndCssCraft: 10,
    },
  }[total as 80 | 90 | 100];
  if (remaining === undefined) throw new Error(`unsupported fixture total ${total}`);
  const scores = {
    ...remaining,
    originalityAndMemorability: originality,
  };
  return {
    schemaVersion: 1 as const,
    generationId: "0001",
    judgeId,
    anonymousCandidateId: anonymousId,
    scores,
    totalScore: Object.values(scores).reduce((sum, score) => sum + score, 0),
    critique: "The hierarchy is clear. Refine the lower rhythm next.",
    strongestQuality: "Clear hierarchy",
    primaryWeakness: "Lower rhythm",
    nextMove: "Refine lower rhythm",
    confidence: "medium" as const,
    flags: [],
    modelUsage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
    },
  };
}

function customJudgment(
  anonymousCandidateId: string,
  judgeId: string,
  overrides: ScoreOverrides = {},
) {
  const scores = {
    hierarchyAndReadability: 12,
    composition: 12,
    typography: 10,
    colourAndVisualSystem: 8,
    coherenceAndCraft: 14,
    originalityAndMemorability: 14,
    constraintAndCssCraft: 10,
    ...overrides,
  };
  return {
    schemaVersion: 1 as const,
    generationId: "0001",
    judgeId,
    anonymousCandidateId,
    scores,
    totalScore: Object.values(scores).reduce((sum, score) => sum + score, 0),
    critique: "The system is clear and intentional. Refine one weak transition next.",
    strongestQuality: "Clear system",
    primaryWeakness: "Weak transition",
    nextMove: "Refine the weak transition",
    confidence: "medium" as const,
    flags: [],
    modelUsage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
    },
  };
}

function scoredJudgment(
  anonymousCandidateId: string,
  judgeId: string,
  scores: JudgmentScores,
) {
  return {
    ...customJudgment(anonymousCandidateId, judgeId),
    scores,
    totalScore: Object.values(scores).reduce((sum, score) => sum + score, 0),
  };
}

function candidate(
  contestantId: string,
  anonymousCandidateId: string,
  displayName = contestantId,
  status: "valid" | "invalid" = "valid",
) {
  return {
    contestantId,
    anonymousCandidateId,
    displayName,
    harnessName: "Fixture",
    modelName: "Fixture model",
    status,
    screenshotPath:
      status === "valid" ? `contestants/${contestantId}/screenshot.png` : null,
    failure: status === "valid" ? null : "fixture failed",
  } as const;
}

describe("ScoreAggregator", () => {
  it("calculates odd-count statistics from validated judgments", () => {
    const leaderboard = new ScoreAggregator().aggregate({
      seasonId: "0001",
      generationId: "0001",
      generatedAt: "2026-08-28T20:00:00.000Z",
      expectedJudgeCount: 3,
      candidates: [
        {
          contestantId: "fixture-editorial",
          anonymousCandidateId: candidateId,
          displayName: "Editorial",
          harnessName: "Fixture",
          modelName: "Editorial model",
          status: "valid",
          screenshotPath: "contestants/fixture-editorial/screenshot.png",
          failure: null,
        },
      ],
      judgments: [
        judgment("judge-a", 80, 14),
        judgment("judge-b", 90, 18),
        judgment("judge-c", 100, 20),
      ],
    });

    const entry = leaderboard.entries[0]!;
    expect(entry.combinedScore).toBe(90);
    expect(entry.medianScore).toBe(90);
    expect(entry.minimumScore).toBe(80);
    expect(entry.maximumScore).toBe(100);
    expect(entry.scoreRange).toBe(20);
    expect(entry.standardDeviation).toBeCloseTo(Math.sqrt(200 / 3));
    expect(entry.originalityScore).toBeCloseTo(52 / 3);
    expect(entry.meanHierarchyAndReadability).toBeCloseTo(40 / 3);
    expect(entry.dimensionMeans?.originalityAndMemorability).toBeCloseTo(52 / 3);
    expect(entry.completedJudgeCount).toBe(3);
    expect(entry.status).toBe("valid");
    expect(serializeLeaderboard(leaderboard)).toBe(
      `${JSON.stringify(leaderboard, null, 2)}\n`,
    );
  });

  it("calculates an even median and population disagreement statistics", () => {
    const leaderboard = new ScoreAggregator().aggregate({
      seasonId: "0001",
      generationId: "0001",
      generatedAt: "2026-08-28T20:00:00.000Z",
      expectedJudgeCount: 2,
      candidates: [candidate("fixture-editorial", candidateId)],
      judgments: [judgment("judge-a", 80, 14), judgment("judge-b", 90, 18)],
    });
    const entry = leaderboard.entries[0]!;
    expect(entry.combinedScore).toBe(85);
    expect(entry.medianScore).toBe(85);
    expect(entry.minimumScore).toBe(80);
    expect(entry.maximumScore).toBe(90);
    expect(entry.scoreRange).toBe(10);
    expect(entry.standardDeviation).toBe(5);
  });

  it("records each judge's deterministic candidate ranks", () => {
    const leaderboard = new ScoreAggregator().aggregate({
      seasonId: "0001",
      generationId: "0001",
      generatedAt: "2026-08-28T20:00:00.000Z",
      expectedJudgeCount: 1,
      judges: [{ id: "judge-a" }],
      candidates: [
        candidate("rank-a", "candidate-ranka"),
        candidate("rank-b", "candidate-rankb"),
      ],
      judgments: [
        customJudgment("candidate-ranka", "judge-a", {
          originalityAndMemorability: 18,
          composition: 14,
        }),
        customJudgment("candidate-rankb", "judge-a"),
      ],
    });
    expect(leaderboard.entries.map((entry) => entry.contestantId)).toEqual([
      "rank-a",
      "rank-b",
    ]);
    expect(leaderboard.entries.map((entry) => entry.judgeRanks)).toEqual([
      [{ judgeId: "judge-a", rank: 1 }],
      [{ judgeId: "judge-a", rank: 2 }],
    ]);
    expect(leaderboard.entries[0]?.judgeScores[0]?.candidateRank).toBe(1);
  });

  it("uses the documented tie-break order and keeps failures after rankable entries", () => {
    const first = candidate("first-contestant", "candidate-first", "Zeta");
    const second = candidate("second-contestant", "candidate-second", "Alpha");
    const failed = candidate(
      "failed-contestant",
      "candidate-failed",
      "Beta",
      "invalid",
    );
    const leaderboard = new ScoreAggregator().aggregate({
      seasonId: "0001",
      generationId: "0001",
      generatedAt: "2026-08-28T20:00:00.000Z",
      expectedJudgeCount: 1,
      candidates: [failed, second, first],
      judgments: [
        customJudgment(first.anonymousCandidateId, "judge-a"),
        customJudgment(second.anonymousCandidateId, "judge-a", {
          hierarchyAndReadability: 13,
          originalityAndMemorability: 13,
          composition: 13,
        }),
      ],
    });

    expect(leaderboard.entries.map((entry) => entry.contestantId)).toEqual([
      "second-contestant",
      "first-contestant",
      "failed-contestant",
    ]);
    expect(leaderboard.entries[0]?.rank).toBe(1);
    expect(leaderboard.entries[1]?.rank).toBe(2);
    expect(leaderboard.entries[2]).toMatchObject({
      rank: null,
      status: "invalid",
      combinedScore: null,
      minimumScore: null,
      judgeScores: [],
    });
  });

  it("applies median, originality, hierarchy, and contestant ID tie-breaks in order", () => {
    const aggregate = (
      left: ReturnType<typeof candidate>,
      right: ReturnType<typeof candidate>,
      judgments: readonly ReturnType<typeof scoredJudgment>[],
      expectedFirst: string,
    ) => {
      const leaderboard = new ScoreAggregator().aggregate({
        seasonId: "0001",
        generationId: "0001",
        generatedAt: "2026-08-28T20:00:00.000Z",
        expectedJudgeCount: 3,
        candidates: [left, right],
        judgments,
      });
      expect(leaderboard.entries[0]?.contestantId).toBe(expectedFirst);
    };
    const lowScores: JudgmentScores = {
      hierarchyAndReadability: 10,
      composition: 10,
      typography: 10,
      colourAndVisualSystem: 8,
      coherenceAndCraft: 10,
      originalityAndMemorability: 8,
      constraintAndCssCraft: 4,
    };
    const middleScores: JudgmentScores = {
      hierarchyAndReadability: 12,
      composition: 12,
      typography: 10,
      colourAndVisualSystem: 8,
      coherenceAndCraft: 14,
      originalityAndMemorability: 14,
      constraintAndCssCraft: 10,
    };
    const highScores: JudgmentScores = {
      hierarchyAndReadability: 15,
      composition: 15,
      typography: 15,
      colourAndVisualSystem: 10,
      coherenceAndCraft: 15,
      originalityAndMemorability: 20,
      constraintAndCssCraft: 10,
    };
    aggregate(
      candidate("median-a", "candidate-meda", "A"),
      candidate("median-b", "candidate-medb", "B"),
      [
        scoredJudgment("candidate-meda", "judge-a", lowScores),
        scoredJudgment("candidate-meda", "judge-b", highScores),
        scoredJudgment("candidate-meda", "judge-c", highScores),
        scoredJudgment("candidate-medb", "judge-a", middleScores),
        scoredJudgment("candidate-medb", "judge-b", middleScores),
        scoredJudgment("candidate-medb", "judge-c", highScores),
      ],
      "median-a",
    );
    const highOriginalityScores = {
      ...middleScores,
      composition: 8,
      originalityAndMemorability: 18,
    };
    aggregate(
      candidate("originality-a", "candidate-origa", "A"),
      candidate("originality-b", "candidate-origb", "B"),
      [
        scoredJudgment("candidate-origa", "judge-a", highOriginalityScores),
        scoredJudgment("candidate-origb", "judge-a", middleScores),
      ],
      "originality-a",
    );
    const highHierarchyScores = {
      ...middleScores,
      hierarchyAndReadability: 13,
      composition: 11,
    };
    aggregate(
      candidate("hierarchy-a", "candidate-hiera", "A"),
      candidate("hierarchy-b", "candidate-hierb", "B"),
      [
        scoredJudgment("candidate-hiera", "judge-a", highHierarchyScores),
        scoredJudgment("candidate-hierb", "judge-a", middleScores),
      ],
      "hierarchy-a",
    );
    aggregate(
      candidate("id-a", "candidate-idaa", "Zeta"),
      candidate("id-b", "candidate-idbb", "Alpha"),
      [
        scoredJudgment("candidate-idaa", "judge-a", middleScores),
        scoredJudgment("candidate-idbb", "judge-a", middleScores),
      ],
      "id-a",
    );
  });

  it("ignores invalid and identity-mismatched judgments without fabricating zeros", () => {
    const valid = candidate("valid-contestant", candidateId);
    const noScreenshot = {
      ...candidate("no-screenshot", "candidate-noscreen"),
      screenshotPath: null,
    };
    const validJudgment = customJudgment(candidateId, "judge-a");
    const mismatched = customJudgment("candidate-other", "judge-a");
    const invalid = { ...validJudgment, totalScore: validJudgment.totalScore - 1 };
    const leaderboard = new ScoreAggregator().aggregate({
      seasonId: "0001",
      generationId: "0001",
      generatedAt: "2026-08-28T20:00:00.000Z",
      expectedJudgeCount: 2,
      judges: [{ id: "judge-a" }, { id: "judge-b" }],
      candidates: [valid, noScreenshot],
      judgments: [invalid, mismatched, validJudgment],
    });

    expect(leaderboard.entries[0]).toMatchObject({
      contestantId: "valid-contestant",
      status: "judge_incomplete",
      completedJudgeCount: 1,
      expectedJudgeCount: 2,
    });
    expect(leaderboard.entries[1]).toMatchObject({
      contestantId: "no-screenshot",
      rank: null,
      combinedScore: null,
      completedJudgeCount: 0,
      status: "judge_incomplete",
    });
  });

  it("records self-provider and self-family metadata while awards remain non-numeric", () => {
    const onlyCandidate = candidate("fixture-editorial", candidateId);
    const scores = customJudgment(candidateId, "judge-a");
    const withoutAward = new ScoreAggregator().aggregate({
      seasonId: "0001",
      generationId: "0001",
      generatedAt: "2026-08-28T20:00:00.000Z",
      expectedJudgeCount: 1,
      judges: [
        { id: "judge-a", provider: "local-fixture", modelFamily: "fixture-family" },
      ],
      candidates: [
        {
          ...onlyCandidate,
          provider: "local-fixture",
          modelFamily: "fixture-family",
        },
      ],
      judgments: [scores],
    });
    const withAward = new ScoreAggregator().aggregate({
      seasonId: "0001",
      generationId: "0001",
      generatedAt: "2026-08-28T20:00:00.000Z",
      expectedJudgeCount: 1,
      judges: [
        { id: "judge-a", provider: "local-fixture", modelFamily: "fixture-family" },
      ],
      candidates: [
        {
          ...onlyCandidate,
          provider: "local-fixture",
          modelFamily: "fixture-family",
        },
      ],
      judgments: [scores],
      awards: [
        {
          schemaVersion: 1,
          generationId: "0001",
          judgeId: "judge-a",
          awards: [
            {
              label: "Best Visual Rhythm",
              anonymousCandidateId: candidateId,
              rationale: "The repeated rhythm gives the page a memorable direction.",
            },
          ],
        },
      ],
    });
    expect(withoutAward.entries[0]?.combinedScore).toBe(
      withAward.entries[0]?.combinedScore,
    );
    expect(withAward.entries[0]?.selfFamily).toEqual({
      providerMatches: 1,
      providerComparisons: 1,
      modelFamilyMatches: 1,
      modelFamilyComparisons: 1,
    });
    expect(withAward.entries[0]?.awards).toHaveLength(1);
  });

  it("produces byte-equivalent output for identical validated inputs and a supplied timestamp", () => {
    const input = {
      seasonId: "0001",
      generationId: "0001",
      generatedAt: "2026-08-28T20:00:00.000Z",
      expectedJudgeCount: 1,
      candidates: [candidate("fixture-editorial", candidateId)],
      judgments: [customJudgment(candidateId, "judge-a")],
    } as const;
    const aggregator = new ScoreAggregator();
    expect(serializeLeaderboard(aggregator.aggregate(input))).toBe(
      serializeLeaderboard(aggregator.aggregate(input)),
    );
  });
});
