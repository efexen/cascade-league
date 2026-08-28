import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createGeneration } from "../../src/artifacts/generation.js";
import {
  FixtureContestantAdapter,
  type ContestantAdapter,
} from "../../src/contestants/index.js";
import { buildGallery } from "../../src/gallery/index.js";
import { FixtureJudgeAdapter, type JudgeAdapter } from "../../src/judging/index.js";
import { runGeneration } from "../../src/orchestration/generation.js";
import { runWaveB } from "../../src/orchestration/wave-b.js";
import { ManifestSchema, RunSchema, TaskStateSchema } from "../../src/schemas/index.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

function fixtureContestantAdapter(
  fixture: FixtureContestantAdapter,
  fixtureName: string,
  calls?: Map<string, number>,
): ContestantAdapter {
  return {
    run: (input) => {
      calls?.set(input.contestant.id, (calls.get(input.contestant.id) ?? 0) + 1);
      const harness = input.contestant.harness;
      const fixtureHarness = {
        adapter: "fixture" as const,
        name: harness.name,
        fixture: fixtureName,
        ...(harness.version === undefined ? {} : { version: harness.version }),
      };
      return fixture.run({
        ...input,
        contestant: { ...input.contestant, harness: fixtureHarness },
      });
    },
  };
}

function fixtureJudgeAdapter(
  fixture: FixtureJudgeAdapter,
  fixtureName: string,
  scoreCalls?: Map<string, number>,
): JudgeAdapter {
  return {
    scoreCandidate: (input) => {
      const key = `${input.judgeId}/${input.anonymousCandidateId}`;
      scoreCalls?.set(key, (scoreCalls.get(key) ?? 0) + 1);
      const harness = input.judge.harness;
      const fixtureHarness = {
        adapter: "fixture" as const,
        name: harness.name,
        fixture: fixtureName,
        ...(harness.version === undefined ? {} : { version: harness.version }),
      };
      return fixture.scoreCandidate({
        ...input,
        judge: { ...input.judge, harness: fixtureHarness },
      });
    },
    createAwards: (input) => {
      const harness = input.judge.harness;
      const fixtureHarness = {
        adapter: "fixture" as const,
        name: harness.name,
        fixture: fixtureName,
        ...(harness.version === undefined ? {} : { version: harness.version }),
      };
      return fixture.createAwards({
        ...input,
        judge: { ...input.judge, harness: fixtureHarness },
      });
    },
  };
}

describe("complete generation orchestration", () => {
  it("rebuilds from archived gallery source after repository challenge drift", async () => {
    const repositoryParent = await mkdtemp(
      join(tmpdir(), "local-maxima-archived-gallery-repository-"),
    );
    const temporaryRepository = join(repositoryParent, "repository");
    await cp(repositoryRoot, temporaryRepository, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${join("", "node_modules")}/`) &&
        !source.endsWith(`${join("", "node_modules")}`) &&
        !source.includes(`${join("", ".git")}/`) &&
        !source.endsWith(`${join("", ".git")}`),
    });
    const generationsRoot = join(repositoryParent, "generations");
    const generation = await createGeneration({
      repositoryRoot: temporaryRepository,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const completed = await runGeneration({
      repositoryRoot: temporaryRepository,
      generationPath: generation.generationPath,
      generatedAt: "2026-08-28T20:15:00.000Z",
    });
    const publicFiles = [
      "index.html",
      "champion.css",
      "gallery-screenshot.png",
      "metadata.json",
    ];
    const before = await Promise.all(
      publicFiles.map(
        async (file) =>
          [file, await readFile(join(completed.gallery.publicPath, file))] as const,
      ),
    );

    await rm(join(temporaryRepository, "challenge/season-001/challenge.hbs"));
    await rm(join(temporaryRepository, "challenge/season-001/challenge.yaml"));

    await buildGallery({
      repositoryRoot: temporaryRepository,
      generationPath: generation.generationPath,
    });
    for (const [file, bytes] of before) {
      expect(await readFile(join(completed.gallery.publicPath, file))).toEqual(bytes);
    }
  }, 30000);

  it("rejects a tampered archived gallery source before creating public output", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-gallery-archive-tamper-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: "2026-08-28T20:15:00.000Z",
    });
    const archivePath = join(
      generation.generationPath,
      "challenge/source-archive.json",
    );
    await chmod(archivePath, 0o644);
    await writeFile(archivePath, `${await readFile(archivePath, "utf8")}\n`, "utf8");

    await expect(
      buildGallery({
        repositoryRoot,
        generationPath: generation.generationPath,
      }),
    ).rejects.toThrow(/archive|hash|integrity/i);
    expect(await readdir(join(generation.generationPath, "public"))).toEqual(
      expect.arrayContaining([
        "index.html",
        "champion.css",
        "gallery-screenshot.png",
        "metadata.json",
      ]),
    );
    expect(
      (await readdir(generation.generationPath)).filter((name) =>
        name.startsWith(".public.build-"),
      ),
    ).toEqual([]);
  }, 30000);

  it("creates and advances a new generation through Wave B once", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-new-generation-"),
    );
    const progress: string[] = [];

    const result = await runGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generatedAt: "2026-08-28T20:15:00.000Z",
      onProgress: (message) => progress.push(message),
    });

    expect(progress).toHaveLength(5);
    expect(result.generationPath).toBe(join(generationsRoot, "0001"));
  }, 30000);

  it("runs the fixture tournament through scoring, gallery, and completion", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generation-"));
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });

    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      now: "2026-08-28T20:15:00.000Z",
      generatedAt: "2026-08-28T20:15:00.000Z",
    });

    expect(result.leaderboard.entries[0]?.contestantId).toBe("fixture-editorial");
    expect(
      ManifestSchema.parse(
        JSON.parse(
          await readFile(join(generation.generationPath, "manifest.json"), "utf8"),
        ) as unknown,
      ).status,
    ).toBe("completed");
    expect(result.gallery.publicPath).toBe(join(generation.generationPath, "public"));
  }, 30000);

  it("uses configured concurrency in the resumable production path", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-resumable-concurrency-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const contestantFixture = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 40,
    });
    let activeContestants = 0;
    let maximumContestants = 0;
    const contestantAdapters = new Map<string, ContestantAdapter>(
      ["fixture-editorial", "fixture-geometric", "fixture-generic"].map((id) => [
        id,
        {
          run: async (input) => {
            activeContestants += 1;
            maximumContestants = Math.max(maximumContestants, activeContestants);
            try {
              return await contestantFixture.run(input);
            } finally {
              activeContestants -= 1;
            }
          },
        },
      ]),
    );

    const judgeFixture = new FixtureJudgeAdapter({ delayMs: 40 });
    const activeJudges = new Map<string, number>();
    const maximumJudges = new Map<string, number>();
    const judgeAdapters = new Map<string, JudgeAdapter>(
      ["fixture-critic-a", "fixture-critic-b"].map((judgeId) => [
        judgeId,
        {
          scoreCandidate: async (input) => {
            const active = (activeJudges.get(judgeId) ?? 0) + 1;
            activeJudges.set(judgeId, active);
            maximumJudges.set(
              judgeId,
              Math.max(maximumJudges.get(judgeId) ?? 0, active),
            );
            try {
              return await judgeFixture.scoreCandidate(input);
            } finally {
              activeJudges.set(judgeId, active - 1);
            }
          },
          createAwards: (input) => judgeFixture.createAwards(input),
        },
      ]),
    );

    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      resumable: true,
      contestantAdapters,
      judgeAdapters,
      generatedAt: "2026-08-28T20:15:00.000Z",
    });

    expect(result.leaderboard.entries[0]?.contestantId).toBe("fixture-editorial");
    expect(maximumContestants).toBeGreaterThan(1);
    expect(maximumContestants).toBeLessThanOrEqual(4);
    for (const judgeId of ["fixture-critic-a", "fixture-critic-b"]) {
      expect(maximumJudges.get(judgeId)).toBeGreaterThan(1);
      expect(maximumJudges.get(judgeId)).toBeLessThanOrEqual(2);
    }
  }, 30000);

  it("rebuilds public output deterministically without changing source artifacts", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-gallery-rebuild-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: "2026-08-28T20:15:00.000Z",
    });
    const sourceFiles = [
      "manifest.json",
      "leaderboard.json",
      "contestants/fixture-editorial/submission.css",
      "contestants/fixture-editorial/screenshot.png",
    ];
    const sourceHashes = new Map<string, string>();
    for (const file of sourceFiles) {
      sourceHashes.set(
        file,
        createHash("sha256")
          .update(await readFile(join(generation.generationPath, file)))
          .digest("hex"),
      );
    }
    const publicBefore = await Promise.all(
      ["index.html", "champion.css", "gallery-screenshot.png", "metadata.json"].map(
        async (file) =>
          [file, await readFile(join(result.gallery.publicPath, file))] as const,
      ),
    );
    await buildGallery({ repositoryRoot, generationPath: generation.generationPath });
    for (const [file, bytes] of publicBefore) {
      expect(await readFile(join(result.gallery.publicPath, file))).toEqual(bytes);
    }
    for (const [file, hash] of sourceHashes) {
      expect(
        createHash("sha256")
          .update(await readFile(join(generation.generationPath, file)))
          .digest("hex"),
      ).toBe(hash);
    }
  }, 30000);

  it("resumes after a render interruption without rerunning terminal contestant tasks", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-resume-generation-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixture = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const calls = new Map<string, number>();
    const contestantAdapters = new Map(
      ["fixture-editorial", "fixture-geometric", "fixture-generic"].map((id) => [
        id,
        {
          run: async (input: Parameters<typeof fixture.run>[0]) => {
            calls.set(id, (calls.get(id) ?? 0) + 1);
            return fixture.run(input);
          },
        },
      ]),
    );
    let interrupted = false;
    await expect(
      runGeneration({
        repositoryRoot,
        generationPath: generation.generationPath,
        resumable: true,
        contestantAdapters,
        afterTask: async (task) => {
          if (!interrupted && task.role === "render") {
            interrupted = true;
            throw new Error("simulated interruption");
          }
        },
      }),
    ).rejects.toThrow("simulated interruption");

    const firstContestantPath = join(
      generation.generationPath,
      "contestants/fixture-editorial",
    );
    const preservedFiles = [
      "run.json",
      "submission.css",
      "validation.json",
      "screenshot.png",
    ];
    const preservedHashes = new Map(
      await Promise.all(
        preservedFiles.map(async (file) => {
          const bytes = await readFile(join(firstContestantPath, file));
          return [file, createHash("sha256").update(bytes).digest("hex")] as const;
        }),
      ),
    );

    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      resumable: true,
      contestantAdapters,
    });
    expect(result.leaderboard.entries[0]?.contestantId).toBe("fixture-editorial");
    expect(calls.get("fixture-editorial")).toBe(1);
    expect(calls.get("fixture-geometric")).toBe(1);
    expect(calls.get("fixture-generic")).toBe(1);
    for (const file of preservedFiles) {
      const bytes = await readFile(join(firstContestantPath, file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        preservedHashes.get(file),
      );
    }
    expect(
      ManifestSchema.parse(
        JSON.parse(
          await readFile(join(generation.generationPath, "manifest.json"), "utf8"),
        ) as unknown,
      ).status,
    ).toBe("completed");
  }, 30000);

  it("resumes pending judge work while preserving a completed judgment", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-resume-judge-"));
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixture = new FixtureJudgeAdapter({ delayMs: 1 });
    const scoreCalls = new Map<string, number>();
    let awardsCalls = 0;
    const judgeAdapters = new Map<string, JudgeAdapter>(
      ["fixture-critic-a", "fixture-critic-b"].map((judgeId) => [
        judgeId,
        {
          scoreCandidate: async (input) => {
            const key = `${input.judgeId}/${input.anonymousCandidateId}`;
            scoreCalls.set(key, (scoreCalls.get(key) ?? 0) + 1);
            return fixture.scoreCandidate(input);
          },
          createAwards: async (input) => {
            awardsCalls += 1;
            return fixture.createAwards(input);
          },
        },
      ]),
    );
    let interrupted = false;
    let interruptedTaskTarget: string | null = null;
    await expect(
      runGeneration({
        repositoryRoot,
        generationPath: generation.generationPath,
        resumable: true,
        judgeAdapters,
        afterTask: async (task) => {
          if (!interrupted && task.role === "judge") {
            interrupted = true;
            interruptedTaskTarget = task.targetId;
            throw new Error("simulated judge interruption");
          }
        },
      }),
    ).rejects.toThrow("simulated judge interruption");
    expect(interruptedTaskTarget).not.toBeNull();
    const [judgeId, anonymousCandidateId] = interruptedTaskTarget!.split("\0");
    const judgmentPath = join(
      generation.generationPath,
      "judging",
      judgeId!,
      `${anonymousCandidateId!}.json`,
    );
    const judgmentHash = createHash("sha256")
      .update(await readFile(judgmentPath))
      .digest("hex");

    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      resumable: true,
      judgeAdapters,
    });
    expect(result.leaderboard.entries[0]?.contestantId).toBe("fixture-editorial");
    expect(scoreCalls.get(`${judgeId!}/${anonymousCandidateId!}`)).toBe(1);
    expect([...scoreCalls.values()].reduce((sum, value) => sum + value, 0)).toBe(6);
    expect(awardsCalls).toBe(2);
    expect(
      createHash("sha256")
        .update(await readFile(judgmentPath))
        .digest("hex"),
    ).toBe(judgmentHash);
    const task = TaskStateSchema.parse(
      JSON.parse(
        await readFile(
          join(
            generation.generationPath,
            "judging",
            judgeId!,
            "tasks",
            `${anonymousCandidateId!}.json`,
          ),
          "utf8",
        ),
      ) as unknown,
    );
    expect(task.status).toBe("succeeded");
    expect(
      ManifestSchema.parse(
        JSON.parse(
          await readFile(join(generation.generationPath, "manifest.json"), "utf8"),
        ) as unknown,
      ).status,
    ).toBe("completed");
  }, 30000);

  it("does not rerun a terminal awards task after interruption", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-resume-awards-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixture = new FixtureJudgeAdapter({ delayMs: 1 });
    let awardsCalls = 0;
    const judgeAdapters = new Map<string, JudgeAdapter>(
      ["fixture-critic-a", "fixture-critic-b"].map((judgeId) => [
        judgeId,
        {
          scoreCandidate: (input) => fixture.scoreCandidate(input),
          createAwards: async (input) => {
            awardsCalls += 1;
            return fixture.createAwards(input);
          },
        },
      ]),
    );
    let interrupted = false;
    await expect(
      runGeneration({
        repositoryRoot,
        generationPath: generation.generationPath,
        resumable: true,
        judgeAdapters,
        afterTask: async (task) => {
          if (!interrupted && task.role === "awards") {
            interrupted = true;
            throw new Error("simulated awards interruption");
          }
        },
      }),
    ).rejects.toThrow("simulated awards interruption");
    expect(awardsCalls).toBe(1);

    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      resumable: true,
      judgeAdapters,
    });
    expect(awardsCalls).toBe(2);
    for (const judgeId of ["fixture-critic-a", "fixture-critic-b"]) {
      const task = TaskStateSchema.parse(
        JSON.parse(
          await readFile(
            join(generation.generationPath, "judging", judgeId, "awards-task.json"),
            "utf8",
          ),
        ) as unknown,
      );
      expect(task.status).toBe("succeeded");
    }
  }, 30000);

  it("does not retry a judge task left running with an unknown request outcome", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-uncertain-judge-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const firstPass = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      resumable: true,
    });
    const judgeId = "fixture-critic-a";
    const anonymousCandidateId = firstPass.judges.find(
      (judge) => judge.judgeId === judgeId,
    )!.candidates[0]!.anonymousCandidateId;
    const judgmentPath = join(
      generation.generationPath,
      "judging",
      judgeId,
      `${anonymousCandidateId}.json`,
    );
    await rm(judgmentPath);
    const taskPath = join(
      generation.generationPath,
      "judging",
      judgeId,
      "tasks",
      `${anonymousCandidateId}.json`,
    );
    const completedTask = TaskStateSchema.parse(
      JSON.parse(await readFile(taskPath, "utf8")) as unknown,
    );
    await writeFile(
      taskPath,
      `${JSON.stringify(
        TaskStateSchema.parse({
          ...completedTask,
          status: "running",
          completedAt: null,
          requestAccepted: true,
          error: null,
        }),
        null,
        2,
      )}\n`,
    );
    const fixture = new FixtureJudgeAdapter({ delayMs: 1 });
    const scoreCalls = new Map<string, number>();
    const judgeAdapters = new Map<string, JudgeAdapter>(
      ["fixture-critic-a", "fixture-critic-b"].map((id) => [
        id,
        fixtureJudgeAdapter(fixture, id.replace("fixture-", ""), scoreCalls),
      ]),
    );
    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      judgeAdapters,
    });
    expect(scoreCalls.get(`${judgeId}/${anonymousCandidateId}`) ?? 0).toBe(0);
    expect(
      TaskStateSchema.parse(JSON.parse(await readFile(taskPath, "utf8")) as unknown)
        .status,
    ).toBe("uncertain");
    expect(
      result.leaderboard.entries.some(
        (entry) => entry.completedJudgeCount === 1 && entry.rank !== null,
      ),
    ).toBe(true);
    expect(
      ManifestSchema.parse(
        JSON.parse(
          await readFile(join(generation.generationPath, "manifest.json"), "utf8"),
        ) as unknown,
      ).status,
    ).toBe("completed");
  }, 30000);

  it("does not rerun a terminally failed contestant task on resume", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-resume-failed-contestant-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixture = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const calls = new Map<string, number>();
    const contestantAdapters = new Map(
      ["fixture-editorial", "fixture-geometric", "fixture-generic"].map((id) => [
        id,
        fixtureContestantAdapter(
          fixture,
          id === "fixture-editorial" ? "failure" : id.replace("fixture-", ""),
          calls,
        ),
      ]),
    );
    let interrupted = false;
    let interruptedTaskId: string | null = null;
    await expect(
      runGeneration({
        repositoryRoot,
        generationPath: generation.generationPath,
        contestantAdapters,
        afterTask: async (task) => {
          if (!interrupted && task.role === "contestant") {
            interrupted = true;
            interruptedTaskId = task.taskId;
            throw new Error("interrupt after failed contestant");
          }
        },
      }),
    ).rejects.toThrow("interrupt after failed contestant");
    const failedTask = TaskStateSchema.parse(
      JSON.parse(
        await readFile(
          join(generation.generationPath, "contestants/fixture-editorial/task.json"),
          "utf8",
        ),
      ) as unknown,
    );
    expect(interruptedTaskId).toBe(failedTask.taskId);

    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      contestantAdapters,
    });
    const failed = result.leaderboard.entries.find(
      (entry) => entry.contestantId === "fixture-editorial",
    );
    expect(failed).toMatchObject({
      status: "execution_failed",
      rank: null,
      combinedScore: null,
    });
    expect(calls.get("fixture-editorial")).toBe(1);
    expect(calls.get("fixture-geometric")).toBe(1);
    expect(calls.get("fixture-generic")).toBe(1);
    expect(
      TaskStateSchema.parse(
        JSON.parse(
          await readFile(
            join(generation.generationPath, "contestants/fixture-editorial/task.json"),
            "utf8",
          ),
        ) as unknown,
      ).status,
    ).toBe("failed");
  }, 30000);

  it("marks ambiguous contestant work uncertain without retrying the adapter", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-resume-uncertain-contestant-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const contestantPath = join(
      generation.generationPath,
      "contestants/fixture-editorial",
    );
    const pendingRun = RunSchema.parse(
      JSON.parse(await readFile(join(contestantPath, "run.json"), "utf8")) as unknown,
    );
    const startedAt = "2026-08-28T20:01:00.000Z";
    await writeFile(
      join(contestantPath, "run.json"),
      `${JSON.stringify(
        RunSchema.parse({
          ...pendingRun,
          status: "running",
          startedAt,
          completedAt: null,
          durationMs: null,
          exitCode: null,
          timedOut: false,
          attemptCount: 1,
          error: null,
        }),
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(contestantPath, "task.json"),
      `${JSON.stringify(
        TaskStateSchema.parse({
          schemaVersion: 1,
          taskId: "0001-contestant-fixture-editorial",
          role: "contestant",
          targetId: "fixture-editorial",
          status: "running",
          startedAt,
          completedAt: null,
          attemptCount: 1,
          requestAccepted: true,
          error: null,
        }),
        null,
        2,
      )}\n`,
    );
    const fixture = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const calls = new Map<string, number>();
    const contestantAdapters = new Map(
      ["fixture-editorial", "fixture-geometric", "fixture-generic"].map((id) => [
        id,
        fixtureContestantAdapter(fixture, id.replace("fixture-", ""), calls),
      ]),
    );

    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      contestantAdapters,
    });
    expect(calls.get("fixture-editorial") ?? 0).toBe(0);
    expect(
      RunSchema.parse(
        JSON.parse(await readFile(join(contestantPath, "run.json"), "utf8")) as unknown,
      ).status,
    ).toBe("uncertain");
    expect(
      TaskStateSchema.parse(
        JSON.parse(
          await readFile(join(contestantPath, "task.json"), "utf8"),
        ) as unknown,
      ).status,
    ).toBe("uncertain");
    expect(
      TaskStateSchema.parse(
        JSON.parse(
          await readFile(join(contestantPath, "render-task.json"), "utf8"),
        ) as unknown,
      ).status,
    ).toBe("invalid");
    expect(result.leaderboard.entries[0]?.contestantId).not.toBe("fixture-editorial");
    expect(
      ManifestSchema.parse(
        JSON.parse(
          await readFile(join(generation.generationPath, "manifest.json"), "utf8"),
        ) as unknown,
      ).status,
    ).toBe("completed");
  }, 30000);

  it("recovers a terminal contestant run written before its task checkpoint", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-resume-terminal-run-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
      resumable: true,
    });

    const contestantPath = join(
      generation.generationPath,
      "contestants/fixture-editorial",
    );
    const taskPath = join(contestantPath, "task.json");
    const task = TaskStateSchema.parse(
      JSON.parse(await readFile(taskPath, "utf8")) as unknown,
    );
    await writeFile(
      taskPath,
      `${JSON.stringify(
        TaskStateSchema.parse({
          ...task,
          status: "running",
          completedAt: null,
          requestAccepted: true,
          error: null,
        }),
        null,
        2,
      )}\n`,
    );

    const fixture = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const calls = new Map<string, number>();
    const contestantAdapters = new Map(
      ["fixture-editorial", "fixture-geometric", "fixture-generic"].map((id) => [
        id,
        fixtureContestantAdapter(fixture, id.replace("fixture-", ""), calls),
      ]),
    );
    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      contestantAdapters,
    });

    expect(result.leaderboard.entries[0]).toMatchObject({
      contestantId: "fixture-editorial",
      rank: 1,
      status: "valid",
    });
    expect(calls.get("fixture-editorial") ?? 0).toBe(0);
    expect(
      TaskStateSchema.parse(JSON.parse(await readFile(taskPath, "utf8")) as unknown)
        .status,
    ).toBe("succeeded");
    expect(
      RunSchema.parse(
        JSON.parse(await readFile(join(contestantPath, "run.json"), "utf8")) as unknown,
      ).status,
    ).toBe("succeeded");
  }, 30000);

  it("builds a fallback gallery when every contestant fails", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-no-valid-contestant-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixture = new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      delayMs: 1,
    });
    const contestantAdapters = new Map(
      ["fixture-editorial", "fixture-geometric", "fixture-generic"].map((id) => [
        id,
        fixtureContestantAdapter(fixture, "failure"),
      ]),
    );
    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      contestantAdapters,
    });
    expect(result.gallery).toMatchObject({
      championContestantId: null,
      stylesheetKind: "fallback",
    });
    expect(
      result.leaderboard.entries.every(
        (entry) =>
          entry.rank === null &&
          entry.combinedScore === null &&
          entry.awards.length === 0 &&
          entry.status === "execution_failed",
      ),
    ).toBe(true);
    expect(await readFile(join(result.gallery.publicPath, "champion.css"))).toEqual(
      await readFile(join(generation.generationPath, "challenge/fallback.css")),
    );
    expect(
      await readFile(join(result.gallery.publicPath, "index.html"), "utf8"),
    ).toContain("No eligible candidate remained rankable");
  }, 30000);

  it("keeps valid candidate screenshots but selects no champion when every judge is invalid", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-no-judge-"));
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const fixture = new FixtureJudgeAdapter({ delayMs: 1 });
    const invalidJudges = new Map(
      ["fixture-critic-a", "fixture-critic-b"].map((id) => [
        id,
        fixtureJudgeAdapter(fixture, "invalid"),
      ]),
    );
    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      judgeAdapters: invalidJudges,
    });
    expect(result.gallery).toMatchObject({
      championContestantId: null,
      stylesheetKind: "fallback",
    });
    expect(
      result.leaderboard.entries.every(
        (entry) =>
          entry.rank === null &&
          entry.combinedScore === null &&
          entry.completedJudgeCount === 0 &&
          entry.expectedJudgeCount === 2 &&
          entry.status === "judge_incomplete" &&
          entry.screenshotPath !== null,
      ),
    ).toBe(true);
    expect(
      await readFile(join(result.gallery.publicPath, "index.html"), "utf8"),
    ).toContain("No valid judge result");
    expect(await readdir(join(result.gallery.publicPath, "screenshots"))).toHaveLength(
      3,
    );
  }, 30000);
});
