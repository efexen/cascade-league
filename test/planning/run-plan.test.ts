import { describe, expect, it } from "vitest";

import { resolveProfile } from "../../src/config/profiles.js";
import { buildRunPlan, type RunPlanBuilderInput } from "../../src/planning/index.js";
import { RunPlanSchema } from "../../src/schemas/index.js";
import {
  commandContestant,
  commandJudge,
  contestantsDocument,
  judgesDocument,
  profileFromDocuments,
} from "../helpers/profile-documents.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

const hashes = {
  "config/contestants.yaml": "a".repeat(64),
  "config/judges.yaml": "b".repeat(64),
  "config/profile.json": "c".repeat(64),
};

function planInput(overrides: Partial<RunPlanBuilderInput> = {}): RunPlanBuilderInput {
  return {
    seasonId: "0001",
    generationId: "0001",
    previousGenerationId: null,
    configSnapshotHashes: hashes,
    promptOnlyOneShotAccepted: false,
    ...overrides,
  } as RunPlanBuilderInput;
}

describe("run plan call mathematics", () => {
  for (const [contestantCount, judgeCount, maximum] of [
    [2, 1, 5],
    [3, 2, 11],
    [6, 3, 27],
  ] as const) {
    it(`plans ${String(contestantCount)}x${String(judgeCount)} as ${String(contestantCount)} + ${String(contestantCount * judgeCount)} + ${String(judgeCount)} = ${String(maximum)} maximum calls`, async () => {
      const { profile } = await profileFromDocuments(
        contestantsDocument(
          Array.from({ length: contestantCount }, (_, index) =>
            commandContestant(`contestant-${String(index)}`),
          ),
        ),
        judgesDocument(
          Array.from({ length: judgeCount }, (_, index) =>
            commandJudge(`judge-${String(index)}`),
          ),
        ),
      );
      const plan = buildRunPlan(planInput({ profile }));
      RunPlanSchema.parse(plan);
      expect(plan.callCounts).toEqual({
        contestantCalls: contestantCount,
        candidateJudgingCalls: contestantCount * judgeCount,
        awardsCalls: judgeCount,
        maximumTotalCalls: maximum,
      });
      expect(plan.externalModelCallsRequired).toBe(true);
    });
  }
});

describe("run plan identities and adapters", () => {
  it("marks the checked-in fixture profile as requiring no external model calls", async () => {
    const profile = await resolveProfile(repositoryRoot, "fixture");
    const plan = buildRunPlan(planInput({ profile }));
    expect(plan.externalModelCallsRequired).toBe(false);
    expect(plan.contestants.map((entry) => entry.id)).toEqual([
      "fixture-editorial",
      "fixture-geometric",
      "fixture-generic",
    ]);
    expect(plan.judges.map((entry) => entry.id)).toEqual([
      "fixture-critic-a",
      "fixture-critic-b",
    ]);
    expect(plan.callCounts.maximumTotalCalls).toBe(11);
    expect(plan.usageReportingUnsupported).toEqual([]);
    expect(plan.promptOnlyOneShot).toEqual([]);
  });

  it("excludes disabled entries from identities, counts, ceilings, and groups", async () => {
    const { profile } = await profileFromDocuments(
      contestantsDocument([
        commandContestant("kept"),
        commandContestant("dropped", { enabled: false }),
      ]),
      judgesDocument([
        commandJudge("kept-judge"),
        commandJudge("dropped-judge", { enabled: false }),
      ]),
    );
    const plan = buildRunPlan(planInput({ profile }));
    expect(plan.contestants.map((entry) => entry.id)).toEqual(["kept"]);
    expect(plan.judges.map((entry) => entry.id)).toEqual(["kept-judge"]);
    expect(plan.callCounts).toEqual({
      contestantCalls: 1,
      candidateJudgingCalls: 1,
      awardsCalls: 1,
      maximumTotalCalls: 3,
    });
    expect(plan.ceilings.contestants.map((entry) => entry.id)).toEqual(["kept"]);
    expect(plan.resourceGroups.lane?.entryIds).toEqual(["kept", "kept-judge"]);
  });
});

describe("run plan ceilings, groups, and flags", () => {
  it("uses entry budgets when present and profile defaults otherwise", async () => {
    const { profile } = await profileFromDocuments(
      contestantsDocument([
        commandContestant("override-budget", {
          budget: { timeoutMs: 123456, maximumTotalTokens: 999 },
        }),
        commandContestant("default-budget"),
      ]),
      judgesDocument([
        commandJudge("override-judge", {
          budget: { timeoutMs: 54321, maximumOutputTokens: 111 },
        }),
        commandJudge("default-judge"),
      ]),
    );
    const plan = buildRunPlan(planInput({ profile }));
    expect(plan.ceilings.contestants).toEqual([
      { id: "override-budget", timeoutMs: 123456, maximumTotalTokens: 999 },
      { id: "default-budget", timeoutMs: 480000, maximumTotalTokens: 30000 },
    ]);
    expect(plan.ceilings.judges).toEqual([
      { id: "override-judge", timeoutMs: 54321, maximumOutputTokens: 111 },
      { id: "default-judge", timeoutMs: 180000, maximumOutputTokens: 4000 },
    ]);
  });

  it("records resource-group concurrency and pacing with assigned entry IDs", async () => {
    const { profile } = await profileFromDocuments(
      contestantsDocument(
        [
          commandContestant("alpha", {
            execution: { resourceGroup: "alpha-lane", oneShotEnforcement: "enforced" },
          }),
          commandContestant("beta", {
            execution: { resourceGroup: "beta-lane", oneShotEnforcement: "enforced" },
          }),
        ],
        {
          resourceGroups: {
            "beta-lane": { maximumConcurrency: 1, minimumStartIntervalMs: 250 },
            "alpha-lane": { maximumConcurrency: 4, minimumStartIntervalMs: 0 },
          },
        },
      ),
      judgesDocument(
        [
          commandJudge("gamma", {
            execution: { resourceGroup: "gamma-lane", oneShotEnforcement: "enforced" },
          }),
        ],
        {
          resourceGroups: {
            "gamma-lane": { maximumConcurrency: 2, minimumStartIntervalMs: 100 },
          },
        },
      ),
    );
    const plan = buildRunPlan(planInput({ profile }));
    expect(Object.keys(plan.resourceGroups)).toEqual([
      "alpha-lane",
      "beta-lane",
      "gamma-lane",
    ]);
    expect(plan.resourceGroups["alpha-lane"]).toEqual({
      maximumConcurrency: 4,
      minimumStartIntervalMs: 0,
      entryIds: ["alpha"],
    });
    expect(plan.resourceGroups["beta-lane"]).toEqual({
      maximumConcurrency: 1,
      minimumStartIntervalMs: 250,
      entryIds: ["beta"],
    });
    expect(plan.resourceGroups["gamma-lane"]).toEqual({
      maximumConcurrency: 2,
      minimumStartIntervalMs: 100,
      entryIds: ["gamma"],
    });
  });

  it("lists enabled command entries whose argv lacks {usageOutputPath}", async () => {
    const noUsage = commandContestant("silent");
    (noUsage.harness as { command: { argv: string[] } }).command.argv = [
      "/absolute/path/to/harness",
      "{promptPath}",
      "{submissionPath}",
    ];
    const { profile } = await profileFromDocuments(
      contestantsDocument([noUsage, commandContestant("loud")]),
      judgesDocument([commandJudge("judge-a")]),
    );
    const plan = buildRunPlan(planInput({ profile }));
    expect(plan.usageReportingUnsupported).toEqual(["silent"]);
  });

  it("records prompt-only contestants and explicit acceptance", async () => {
    const { profile } = await profileFromDocuments(
      contestantsDocument([
        commandContestant("prompt-only", {
          execution: { resourceGroup: "lane", oneShotEnforcement: "prompt_only" },
        }),
        commandContestant("sandboxed"),
      ]),
      judgesDocument([commandJudge("judge-a")]),
    );
    const refused = buildRunPlan(planInput({ profile }));
    expect(refused.promptOnlyOneShot).toEqual(["prompt-only"]);
    expect(refused.promptOnlyOneShotAccepted).toBe(false);
    const accepted = buildRunPlan(
      planInput({ profile, promptOnlyOneShotAccepted: true }),
    );
    expect(accepted.promptOnlyOneShotAccepted).toBe(true);
  });
});

describe("run plan determinism", () => {
  it("serialises byte-identically for identical inputs", async () => {
    const first = await profileFromDocuments(
      contestantsDocument([commandContestant("one"), commandContestant("two")]),
      judgesDocument([commandJudge("judge-a")]),
    );
    const second = await profileFromDocuments(
      contestantsDocument([commandContestant("one"), commandContestant("two")]),
      judgesDocument([commandJudge("judge-a")]),
    );
    const left = JSON.stringify(
      buildRunPlan(
        planInput({
          profile: first.profile,
          generationId: "0002",
          previousGenerationId: "0001",
        }),
      ),
      null,
      2,
    );
    const right = JSON.stringify(
      buildRunPlan(
        planInput({
          profile: second.profile,
          generationId: "0002",
          previousGenerationId: "0001",
        }),
      ),
      null,
      2,
    );
    expect(left).toBe(right);
    expect(left).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("carries the identity fields and config snapshot hashes", async () => {
    const { profile } = await profileFromDocuments(
      contestantsDocument([commandContestant("one"), commandContestant("two")]),
      judgesDocument([commandJudge("judge-a")]),
    );
    const plan = buildRunPlan(
      planInput({
        profile,
        generationId: "0007",
        previousGenerationId: "0006",
      }),
    );
    expect(plan.schemaVersion).toBe(1);
    expect(plan.seasonId).toBe("0001");
    expect(plan.generationId).toBe("0007");
    expect(plan.previousGenerationId).toBe("0006");
    expect(plan.profileId).toBe("temp");
    expect(plan.configSnapshotHashes).toEqual(hashes);
  });
});
