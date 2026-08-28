import { cp, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { createGeneration } from "../../src/artifacts/generation.js";
import {
  FixtureContestantAdapter,
  type ContestantAdapter,
} from "../../src/contestants/index.js";
import { FixtureJudgeAdapter, type JudgeAdapter } from "../../src/judging/index.js";
import { runGeneration } from "../../src/orchestration/generation.js";
import { renderCandidate } from "../../src/rendering/index.js";
import {
  ContestantsConfigSchema,
  RunSchema,
  TaskStateSchema,
  type ContestantsConfig,
} from "../../src/schemas/index.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-maxima-acceptance-repo-"));
  for (const directory of ["challenge", "config", "test/fixtures"]) {
    await cp(join(repositoryRoot, directory), join(root, directory), {
      recursive: true,
    });
  }
  return root;
}

function contestantWithFixture(
  base: ContestantsConfig["contestants"][number],
  id: string,
  displayName: string,
  fixture: string,
  timeoutMs?: number,
): ContestantsConfig["contestants"][number] {
  const budget =
    timeoutMs === undefined
      ? base.budget
      : {
          timeoutMs,
          maximumTotalTokens: base.budget?.maximumTotalTokens ?? 30000,
        };
  return {
    ...base,
    id,
    displayName,
    harness: {
      adapter: "fixture",
      name: base.harness.name,
      fixture,
      ...(base.harness.version === undefined ? {} : { version: base.harness.version }),
    },
    model: {
      ...base.model,
      name: `${id}-model`,
    },
    ...(budget === undefined ? {} : { budget }),
  };
}

function contestantAdapterForFixture(
  fixtureAdapter: FixtureContestantAdapter,
  fixture: string,
  calls: Map<string, number>,
): ContestantAdapter {
  return {
    run: (input) => {
      calls.set(input.contestant.id, (calls.get(input.contestant.id) ?? 0) + 1);
      return fixtureAdapter.run({
        ...input,
        contestant: {
          ...input.contestant,
          harness: {
            adapter: "fixture",
            name: input.contestant.harness.name,
            fixture,
            ...(input.contestant.harness.version === undefined
              ? {}
              : { version: input.contestant.harness.version }),
          },
        },
      });
    },
  };
}

function judgeAdapterForFixture(
  fixtureAdapter: FixtureJudgeAdapter,
  fixture: string,
  scoreCalls: Map<string, number>,
): JudgeAdapter {
  return {
    scoreCandidate: (input) => {
      const key = `${input.judgeId}/${input.anonymousCandidateId}`;
      scoreCalls.set(key, (scoreCalls.get(key) ?? 0) + 1);
      return fixtureAdapter.scoreCandidate({
        ...input,
        judge: {
          ...input.judge,
          harness: {
            adapter: "fixture",
            name: input.judge.harness.name,
            fixture,
            ...(input.judge.harness.version === undefined
              ? {}
              : { version: input.judge.harness.version }),
          },
        },
      });
    },
    createAwards: (input) =>
      fixtureAdapter.createAwards({
        ...input,
        judge: {
          ...input.judge,
          harness: {
            adapter: "fixture",
            name: input.judge.harness.name,
            fixture,
            ...(input.judge.harness.version === undefined
              ? {}
              : { version: input.judge.harness.version }),
          },
        },
      }),
  };
}

describe("Phase 1 acceptance outcomes", () => {
  it("completes the mixed candidate-failure tournament without stopping valid work", async () => {
    const root = await fixtureRepository();
    await writeFile(
      join(root, "test/fixtures/contestants/remote.css"),
      `:root { background: url("https://example.invalid/remote.png"); }\n`,
    );
    const sourceConfig = ContestantsConfigSchema.parse(
      parseYaml(
        await readFile(join(root, "config/contestants.yaml"), "utf8"),
      ) as unknown,
    );
    const base = sourceConfig.contestants[0]!;
    const mixedConfig = ContestantsConfigSchema.parse({
      ...sourceConfig,
      contestants: [
        contestantWithFixture(base, "mixed-valid", "Mixed Valid", "editorial"),
        contestantWithFixture(base, "mixed-remote", "Mixed Remote", "remote"),
        contestantWithFixture(
          base,
          "mixed-no-submission",
          "Mixed No Submission",
          "no-submission",
        ),
        contestantWithFixture(base, "mixed-failure", "Mixed Failure", "failure"),
        contestantWithFixture(base, "mixed-timeout", "Mixed Timeout", "timeout", 10),
        contestantWithFixture(
          base,
          "mixed-render-failure",
          "Mixed Render Failure",
          "editorial",
        ),
      ],
    });
    await writeFile(join(root, "config/contestants.yaml"), stringifyYaml(mixedConfig));
    const generationRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-mixed-generation-"),
    );
    const generation = await createGeneration({
      repositoryRoot: root,
      generationsRoot: generationRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixtureContestant = new FixtureContestantAdapter({
      fixtureRoot: join(root, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const contestantCalls = new Map<string, number>();
    const fixtureNames = new Map([
      ["mixed-valid", "editorial"],
      ["mixed-remote", "remote"],
      ["mixed-no-submission", "no-submission"],
      ["mixed-failure", "failure"],
      ["mixed-timeout", "timeout"],
      ["mixed-render-failure", "editorial"],
    ]);
    const contestantAdapters = new Map(
      [...fixtureNames].map(([id, fixture]) => [
        id,
        contestantAdapterForFixture(fixtureContestant, fixture, contestantCalls),
      ]),
    );
    const fixtureJudge = new FixtureJudgeAdapter({ delayMs: 1 });
    const scoreCalls = new Map<string, number>();
    const judgeAdapters = new Map(
      ["fixture-critic-a", "fixture-critic-b"].map((id) => [
        id,
        judgeAdapterForFixture(fixtureJudge, id.replace("fixture-", ""), scoreCalls),
      ]),
    );
    const result = await runGeneration({
      repositoryRoot: root,
      generationPath: generation.generationPath,
      contestantAdapters,
      judgeAdapters,
      renderer: {
        render: (input) =>
          input.candidateRootPath.includes("mixed-render-failure")
            ? Promise.resolve({
                status: "render_failed" as const,
                screenshotPath: null,
                renderChecks: [
                  {
                    code: "fixture_render",
                    status: "failed" as const,
                    message: "fixture render failure",
                  },
                ],
                errors: ["fixture render failure"],
                warnings: [],
                externalRequests: [],
                observedVersions: {
                  playwright: "fixture",
                  chromium: "fixture",
                },
              })
            : renderCandidate(input),
      },
    });

    expect(result.leaderboard.entries[0]).toMatchObject({
      contestantId: "mixed-valid",
      rank: 1,
      status: "valid",
      completedJudgeCount: 2,
      expectedJudgeCount: 2,
    });
    expect(
      result.leaderboard.entries
        .slice(1)
        .map((entry) => [
          entry.contestantId,
          entry.status,
          entry.rank,
          entry.combinedScore,
        ]),
    ).toEqual([
      ["mixed-failure", "execution_failed", null, null],
      ["mixed-no-submission", "execution_failed", null, null],
      ["mixed-remote", "invalid", null, null],
      ["mixed-render-failure", "render_failed", null, null],
      ["mixed-timeout", "timeout", null, null],
    ]);
    expect([...contestantCalls.values()]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(scoreCalls.size).toBe(2);
    expect([...scoreCalls.values()]).toEqual([1, 1]);
    expect(
      result.leaderboard.entries
        .filter((entry) => entry.contestantId !== "mixed-valid")
        .every(
          (entry) => entry.combinedScore === null && entry.judgeScores.length === 0,
        ),
    ).toBe(true);
    expect(
      RunSchema.parse(
        JSON.parse(
          await readFile(
            join(generation.generationPath, "contestants/mixed-timeout/run.json"),
            "utf8",
          ),
        ) as unknown,
      ).status,
    ).toBe("timeout");
    for (const judgeId of ["fixture-critic-a", "fixture-critic-b"]) {
      const taskFiles = await readdir(
        join(generation.generationPath, "judging", judgeId, "tasks"),
      );
      expect(taskFiles.length).toBe(6);
      for (const taskFile of taskFiles) {
        expect(
          TaskStateSchema.parse(
            JSON.parse(
              await readFile(
                join(generation.generationPath, "judging", judgeId, "tasks", taskFile),
                "utf8",
              ),
            ) as unknown,
          ).status,
        ).not.toMatch(/^(?:pending|running)$/u);
      }
    }
  }, 30000);

  it("keeps valid scores and ranks candidates as judge_incomplete when one judge is invalid", async () => {
    const generationRoot = await mkdtemp(join(tmpdir(), "local-maxima-invalid-judge-"));
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot: generationRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixture = new FixtureJudgeAdapter({ delayMs: 1 });
    const scoreCalls = new Map<string, number>();
    const judgeAdapters = new Map([
      ["fixture-critic-a", judgeAdapterForFixture(fixture, "invalid", scoreCalls)],
      ["fixture-critic-b", judgeAdapterForFixture(fixture, "critic-b", scoreCalls)],
    ]);
    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      judgeAdapters,
    });

    expect(
      result.leaderboard.entries.every(
        (entry) =>
          entry.rank !== null &&
          entry.status === "judge_incomplete" &&
          entry.completedJudgeCount === 1 &&
          entry.expectedJudgeCount === 2 &&
          entry.judgeScores.length === 1 &&
          entry.combinedScore !== null,
      ),
    ).toBe(true);
    expect(result.gallery.championContestantId).toBe("fixture-geometric");
    expect(
      await readFile(join(result.gallery.publicPath, "index.html"), "utf8"),
    ).toContain("1 / 2");
    const rawFiles = await readdir(
      join(generation.generationPath, "judging/fixture-critic-a/raw"),
    );
    expect(rawFiles).toHaveLength(3);
    expect(
      await readFile(
        join(generation.generationPath, "judging/fixture-critic-a/raw", rawFiles[0]!),
        "utf8",
      ),
    ).toContain("not valid judge JSON");
    expect(scoreCalls.size).toBe(6);
  }, 30000);
});
