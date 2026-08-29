import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createGeneration } from "../../src/artifacts/generation.js";
import { runWaveB } from "../../src/orchestration/wave-b.js";
import {
  aggregateGenerationArtifacts,
  writeGenerationLeaderboard,
} from "../../src/scoring/generation.js";
import { LeaderboardSchema, ValidationSchema } from "../../src/schemas/index.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

describe("generation scoring artifacts", () => {
  it("rejects an anonymous map that disagrees with an immutable contestant identity", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-map-integrity-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const mapPath = join(generation.generationPath, "judging/anonymous-map.json");
    const map = JSON.parse(await readFile(mapPath, "utf8")) as {
      entries: { contestantId: string; anonymousCandidateId: string }[];
    };
    const first = map.entries[0]!;
    const second = map.entries[1]!;
    [first.anonymousCandidateId, second.anonymousCandidateId] = [
      second.anonymousCandidateId,
      first.anonymousCandidateId,
    ];
    await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");

    await expect(
      aggregateGenerationArtifacts({ generationPath: generation.generationPath }),
    ).rejects.toThrow(/anonymous|identity|map/i);
  });

  it("does not rank a screenshot left behind by a pending contestant task", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-pending-score-generation-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const contestantPath = join(
      generation.generationPath,
      "contestants/fixture-editorial",
    );
    const validation = ValidationSchema.parse({
      schemaVersion: 1,
      status: "valid",
      submissionSha256: "a".repeat(64),
      sanitisedSha256: "b".repeat(64),
      submissionBytes: 1,
      staticChecks: [],
      renderChecks: [],
      renderEnvironment: { playwright: "fixture", chromium: "fixture" },
      errors: [],
      warnings: [],
    });
    await writeFile(
      join(contestantPath, "validation.json"),
      `${JSON.stringify(validation)}\n`,
    );
    await writeFile(join(contestantPath, "screenshot.png"), "stale artifact");

    const leaderboard = await aggregateGenerationArtifacts({
      generationPath: generation.generationPath,
      generatedAt: "2026-08-28T20:15:00.000Z",
    });

    expect(leaderboard.entries[0]).toMatchObject({
      rank: null,
      status: "execution_failed",
      combinedScore: null,
      completedJudgeCount: 0,
    });
  });

  it("aggregates the completed local judgment artifacts and writes a validated leaderboard", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-score-generation-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    await runWaveB({ repositoryRoot, generationPath: generation.generationPath });

    const leaderboard = await aggregateGenerationArtifacts({
      generationPath: generation.generationPath,
      generatedAt: "2026-08-28T20:15:00.000Z",
    });
    expect(leaderboard.entries.map((entry) => entry.contestantId)).toEqual([
      "fixture-editorial",
      "fixture-geometric",
      "fixture-generic",
    ]);
    expect(leaderboard.entries[0]).toMatchObject({
      rank: 1,
      combinedScore: 88.5,
      completedJudgeCount: 2,
      expectedJudgeCount: 2,
      status: "valid",
    });
    await writeGenerationLeaderboard(generation.generationPath, leaderboard);
    expect(
      LeaderboardSchema.parse(
        JSON.parse(
          await readFile(join(generation.generationPath, "leaderboard.json"), "utf8"),
        ) as unknown,
      ),
    ).toEqual(leaderboard);
  }, 30000);

  it("ignores a valid judgment stored under the wrong judge directory", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-mismatched-judgment-generation-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    await runWaveB({ repositoryRoot, generationPath: generation.generationPath });

    const judgePath = join(generation.generationPath, "judging/fixture-critic-a");
    const candidateFile = (await readdir(judgePath)).find((file) =>
      /^candidate-[a-z0-9]+\.json$/u.test(file),
    );
    if (candidateFile === undefined) throw new Error("fixture judgment is missing");
    const judgmentPath = join(judgePath, candidateFile);
    const judgment = JSON.parse(await readFile(judgmentPath, "utf8")) as {
      judgeId: string;
      [key: string]: unknown;
    };
    judgment.judgeId = "fixture-critic-b";
    await writeFile(judgmentPath, `${JSON.stringify(judgment)}\n`);
    await rm(
      join(generation.generationPath, "judging/fixture-critic-b", candidateFile),
    );

    const leaderboard = await aggregateGenerationArtifacts({
      generationPath: generation.generationPath,
      generatedAt: "2026-08-28T20:15:00.000Z",
    });

    expect(
      leaderboard.entries.reduce((count, entry) => count + entry.judgeScores.length, 0),
    ).toBe(4);
  }, 30000);
});
