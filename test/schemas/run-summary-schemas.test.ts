import { describe, expect, it } from "vitest";

import { RunSummarySchema } from "../../src/schemas/index.js";

function validSummary(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    seasonId: "0001",
    generationId: "0001",
    generatedAt: "2026-08-30T10:05:05.000Z",
    wallClock: {
      startedAt: "2026-08-30T10:00:05.000Z",
      completedAt: "2026-08-30T10:05:05.000Z",
      elapsedMs: 300000,
    },
    taskCounts: [
      {
        role: "contestant",
        planned: 1,
        started: null,
        succeeded: null,
        failed: null,
        timeout: null,
        missingSubmission: null,
        invalid: null,
        uncertain: null,
      },
      {
        role: "render",
        planned: 1,
        started: null,
        succeeded: null,
        failed: null,
        timeout: null,
        missingSubmission: null,
        invalid: null,
        uncertain: null,
      },
      {
        role: "judge",
        planned: 1,
        started: null,
        succeeded: null,
        failed: null,
        timeout: null,
        missingSubmission: null,
        invalid: null,
        uncertain: null,
      },
      {
        role: "awards",
        planned: 1,
        started: null,
        succeeded: null,
        failed: null,
        timeout: null,
        missingSubmission: null,
        invalid: null,
        uncertain: null,
      },
    ],
    contestants: [
      {
        contestantId: "contestant-a",
        anonymousCandidateId: "candidate-aaaa",
        durationMs: null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          totalTokens: null,
        },
        estimatedCostUsd: null,
        versionCompleteness: "unknown",
        oneShotEnforcement: null,
      },
    ],
    judges: [
      {
        judgeId: "judge-a",
        candidateCalls: [
          {
            anonymousCandidateId: "candidate-aaaa",
            durationMs: null,
            usage: { inputTokens: null, outputTokens: null, totalTokens: null },
            estimatedCostUsd: null,
            versionCompleteness: "unknown",
          },
        ],
        awardsCall: {
          durationMs: null,
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
          estimatedCostUsd: null,
          versionCompleteness: "unknown",
        },
      },
    ],
    totals: {
      inputTokens: { value: 0, completeness: "complete" },
      outputTokens: { value: 0, completeness: "complete" },
      reasoningTokens: { value: 0, completeness: "complete" },
      totalTokens: { value: 0, completeness: "complete" },
      estimatedCostUsd: { value: 0, completeness: "complete" },
      callsWithUnknownUsage: 0,
      callsWithUnknownCost: 0,
    },
    configuredMaximumCalls: null,
    resourceGroups: [],
  };
}

describe("run summary schema", () => {
  it("accepts a fully unknown-value summary with known zeros kept distinct", () => {
    expect(RunSummarySchema.parse(validSummary())).toMatchObject({
      totals: { inputTokens: { value: 0, completeness: "complete" } },
    });
  });

  it("rejects unknown keys at every nesting level", () => {
    const withExtra = validSummary();
    (withExtra as Record<string, unknown>).providerRequestId = "req-1";
    expect(RunSummarySchema.safeParse(withExtra).success).toBe(false);

    const nested = validSummary();
    const contestant = (nested.contestants as Record<string, unknown>[])[0]!;
    contestant.stdoutLog = "logs/contestant-aaaa.stdout.log";
    expect(RunSummarySchema.safeParse(nested).success).toBe(false);
  });

  it("requires every role exactly once", () => {
    const missingRole = validSummary();
    missingRole.taskCounts = (
      missingRole.taskCounts as Record<string, unknown>[]
    ).slice(0, 3);
    expect(RunSummarySchema.safeParse(missingRole).success).toBe(false);

    const duplicatedRole = validSummary();
    const counts = duplicatedRole.taskCounts as Record<string, unknown>[];
    counts[1] = { ...counts[0]! };
    expect(RunSummarySchema.safeParse(duplicatedRole).success).toBe(false);
  });

  it("rejects duplicate anonymous candidates and negative aggregates", () => {
    const duplicated = validSummary();
    const judge = (duplicated.judges as Record<string, unknown>[])[0]!;
    const calls = judge.candidateCalls as Record<string, unknown>[];
    judge.candidateCalls = [calls[0]!, { ...calls[0]! }];
    expect(RunSummarySchema.safeParse(duplicated).success).toBe(false);

    const negative = validSummary();
    const totals = negative.totals as Record<string, unknown>;
    totals.inputTokens = { value: -1, completeness: "complete" };
    expect(RunSummarySchema.safeParse(negative).success).toBe(false);
  });

  it("rejects completeness labels outside the known/partial and observed vocabularies", () => {
    const invalidAggregate = validSummary();
    const totals = invalidAggregate.totals as Record<string, unknown>;
    totals.estimatedCostUsd = { value: 0, completeness: "guessed" };
    expect(RunSummarySchema.safeParse(invalidAggregate).success).toBe(false);

    const invalidCall = validSummary();
    const contestant = (invalidCall.contestants as Record<string, unknown>[])[0]!;
    contestant.versionCompleteness = "mostly";
    expect(RunSummarySchema.safeParse(invalidCall).success).toBe(false);
  });
});
