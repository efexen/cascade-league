import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { createGeneration } from "../../src/artifacts/generation.js";
import { CommandContestantAdapter } from "../../src/contestants/index.js";
import { FixtureJudgeAdapter } from "../../src/judging/index.js";
import { runWaveB } from "../../src/orchestration/wave-b.js";
import { ManifestSchema } from "../../src/schemas/index.js";
import {
  commandContestant,
  commandJudge,
  contestantsDocument,
  fixtureJudge,
  judgesDocument,
} from "../helpers/profile-documents.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

interface GuardRepository {
  readonly mirrorRoot: string;
  readonly invocationsPath: string;
}

/**
 * A mirror repository whose "stub" profile runs two offline command
 * contestants: a Node script that appends one line to an invocation log and
 * writes the editorial fixture stylesheet to the submission path. No network
 * access and no paid model call is possible from these entries.
 */
async function repositoryWithCommandContestants(
  judgeKind: "command" | "fixture",
  concurrency = 4,
  promptOnly = false,
  missingEnvironment = false,
): Promise<GuardRepository> {
  const mirrorRoot = await createTestTempRoot("local-maxima-guard-repo-");
  await cp(join(repositoryRoot, "challenge"), join(mirrorRoot, "challenge"), {
    recursive: true,
  });
  await mkdir(join(mirrorRoot, "config/profiles/stub"), { recursive: true });
  const invocationsPath = join(mirrorRoot, "invocations.log");
  const scriptPath = join(mirrorRoot, "stub-contestant.mjs");
  const editorialCss = await readFile(
    join(repositoryRoot, "test/fixtures/contestants/editorial.css"),
    "utf8",
  );
  await writeFile(
    scriptPath,
    [
      'import { appendFileSync, writeFileSync } from "node:fs";',
      'appendFileSync(process.argv[2], "call\\n");',
      `writeFileSync(process.argv[3], ${JSON.stringify(editorialCss)});`,
    ].join("\n"),
    "utf8",
  );
  const stubArgv = [
    process.execPath,
    scriptPath,
    invocationsPath,
    "{submissionPath}",
    "{usageOutputPath}",
    "{promptPath}",
  ];
  const contestantsDoc = contestantsDocument([
    commandContestant("stub-one", {
      harness: {
        name: "stub-harness",
        version: "0.0.1",
        adapter: "command",
        command: {
          argv: stubArgv,
          environmentAllowlist: missingEnvironment ? ["MISSING_GUARD_KEY"] : [],
        },
      },
      execution: {
        resourceGroup: "lane",
        oneShotEnforcement: promptOnly ? "prompt_only" : "enforced",
      },
    }),
    commandContestant("stub-two", {
      harness: {
        name: "stub-harness",
        version: "0.0.1",
        adapter: "command",
        command: {
          argv: stubArgv,
          environmentAllowlist: missingEnvironment ? ["MISSING_GUARD_KEY"] : [],
        },
      },
      execution: {
        resourceGroup: "lane",
        oneShotEnforcement: promptOnly ? "prompt_only" : "enforced",
      },
    }),
  ]);
  contestantsDoc.defaults.concurrency = concurrency;
  await writeFile(
    join(mirrorRoot, "config/profiles/stub/contestants.yaml"),
    stringifyYaml(contestantsDoc),
    "utf8",
  );
  const judgesDoc =
    judgeKind === "command"
      ? judgesDocument([
          commandJudge("stub-judge", {
            harness: {
              name: "stub-judge-harness",
              version: "0.0.1",
              adapter: "command",
              command: {
                argv: [
                  process.execPath,
                  "-e",
                  "process.exit(0)",
                  "{promptPath}",
                  "{judgmentPath}",
                ],
                environmentAllowlist: [],
              },
            },
          }),
        ])
      : judgesDocument([fixtureJudge("fixture-critic-a")]);
  await writeFile(
    join(mirrorRoot, "config/profiles/stub/judges.yaml"),
    stringifyYaml(judgesDoc),
    "utf8",
  );
  return { mirrorRoot, invocationsPath };
}

async function createStubGeneration(mirrorRoot: string) {
  const generationsRoot = await createTestTempRoot("local-maxima-guard-gens-");
  return createGeneration({
    repositoryRoot: mirrorRoot,
    generationsRoot,
    seasonId: "0001",
    profileId: "stub",
    generationId: "0001",
    now: "2026-08-28T20:00:00.000Z",
  });
}

async function readManifestStatus(generationPath: string): Promise<string> {
  const manifest = ManifestSchema.parse(
    JSON.parse(
      await readFile(join(generationPath, "manifest.json"), "utf8"),
    ) as unknown,
  );
  return manifest.status;
}

describe("--allow-model-calls guard", () => {
  it("requires and persists explicit prompt-only acceptance during creation", async () => {
    const { mirrorRoot } = await repositoryWithCommandContestants("fixture", 4, true);
    const generationsRoot = await createTestTempRoot("local-maxima-guard-prompt-only-");

    await expect(
      createGeneration({
        repositoryRoot: mirrorRoot,
        generationsRoot,
        seasonId: "0001",
        profileId: "stub",
        generationId: "0001",
      }),
    ).rejects.toThrow(/prompt-only.*accept/i);

    const created = await createGeneration({
      repositoryRoot: mirrorRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "stub",
      generationId: "0001",
      acceptPromptOnlyOneShot: true,
    });
    const plan = JSON.parse(
      await readFile(join(created.generationPath, "run-plan.json"), "utf8"),
    ) as { promptOnlyOneShotAccepted: boolean };
    expect(plan.promptOnlyOneShotAccepted).toBe(true);
  });

  it("runs shared preflight before creating an invalid command profile", async () => {
    const { mirrorRoot } = await repositoryWithCommandContestants(
      "fixture",
      4,
      false,
      true,
    );
    const generationsRoot = await createTestTempRoot("local-maxima-guard-preflight-");
    await expect(
      createGeneration({
        repositoryRoot: mirrorRoot,
        generationsRoot,
        seasonId: "0001",
        profileId: "stub",
        generationId: "0001",
      }),
    ).rejects.toThrow(/preflight|MISSING_GUARD_KEY/i);
    expect(await readdir(generationsRoot)).toEqual([]);
  });

  it("refuses before creating a generation when runWaveB receives a command profile without consent", async () => {
    const { mirrorRoot, invocationsPath } =
      await repositoryWithCommandContestants("command");
    const generationsRoot = await createTestTempRoot("local-maxima-guard-precreate-");

    await expect(
      runWaveB({
        repositoryRoot: mirrorRoot,
        generationsRoot,
        seasonId: "0001",
        profileId: "stub",
        generationId: "0001",
      }),
    ).rejects.toThrow(
      "generation 0001 may make external model calls: 2 contestant call(s), up to 2 candidate-judging call(s), up to 1 awards call(s) pending; rerun with --allow-model-calls",
    );

    expect(await readdir(generationsRoot)).toEqual([]);
    await expect(readFile(invocationsPath, "utf8")).rejects.toThrow();
  });

  it("refuses a model-call-capable generation with plan maximums and mutates nothing", async () => {
    const { mirrorRoot, invocationsPath } =
      await repositoryWithCommandContestants("command");
    const generation = await createStubGeneration(mirrorRoot);
    await expect(
      runWaveB({
        repositoryRoot: mirrorRoot,
        generationPath: generation.generationPath,
      }),
    ).rejects.toThrow(
      "generation 0001 may make external model calls: 2 contestant call(s), up to 2 candidate-judging call(s), up to 1 awards call(s) pending; rerun with --allow-model-calls",
    );
    expect(await readManifestStatus(generation.generationPath)).toBe("created");
    await expect(
      readFile(
        join(generation.generationPath, "contestants/stub-one/task.json"),
        "utf8",
      ),
    ).rejects.toThrow();
    await expect(
      readFile(
        join(generation.generationPath, "judging/stub-judge/awards-task.json"),
        "utf8",
      ),
    ).rejects.toThrow();
    await expect(readFile(invocationsPath, "utf8")).rejects.toThrow();
  }, 30000);

  it("grants the run when allowModelCalls is provided and completes Wave B offline", async () => {
    const { mirrorRoot, invocationsPath } =
      await repositoryWithCommandContestants("fixture");
    const generation = await createStubGeneration(mirrorRoot);
    const result = await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      allowModelCalls: true,
    });
    expect(
      result.contestants.map((contestant) => contestant.validation.status),
    ).toEqual(["valid", "valid"]);
    expect(await readManifestStatus(generation.generationPath)).toBe(
      "judging_complete",
    );
    const invocations = await readFile(invocationsPath, "utf8");
    expect(invocations.trim().split("\n")).toHaveLength(2);
  }, 60000);

  it("re-refuses resume while command tasks are pending, then completes and skips terminal tasks when granted", async () => {
    const { mirrorRoot, invocationsPath } = await repositoryWithCommandContestants(
      "fixture",
      1,
    );
    const generation = await createStubGeneration(mirrorRoot);
    // A pre-dispatch crash for the second contestant leaves its task pending
    // while the first contestant task reaches a terminal status.
    await expect(
      runWaveB({
        repositoryRoot: mirrorRoot,
        generationPath: generation.generationPath,
        resumable: true,
        allowModelCalls: true,
        contestantAdapterFactory: (contestant) => {
          if (contestant.id === "stub-two") {
            throw new Error("simulated pre-dispatch crash");
          }
          return new CommandContestantAdapter();
        },
      }),
    ).rejects.toThrow("simulated pre-dispatch crash");
    expect((await readFile(invocationsPath, "utf8")).trim().split("\n")).toHaveLength(
      1,
    );

    await expect(
      runWaveB({
        repositoryRoot: mirrorRoot,
        generationPath: generation.generationPath,
        resumable: true,
      }),
    ).rejects.toThrow(
      "generation 0001 may make external model calls: 1 contestant call(s) pending; rerun with --allow-model-calls",
    );
    expect((await readFile(invocationsPath, "utf8")).trim().split("\n")).toHaveLength(
      1,
    );

    const result = await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      resumable: true,
      allowModelCalls: true,
    });
    expect(result.contestants).toHaveLength(2);
    expect(await readManifestStatus(generation.generationPath)).toBe(
      "judging_complete",
    );
    // Exactly one additional invocation: the pending contestant ran, the
    // terminal contestant task was skipped.
    expect((await readFile(invocationsPath, "utf8")).trim().split("\n")).toHaveLength(
      2,
    );
  }, 60000);

  it("proceeds without the flag when every command task is already terminal", async () => {
    const { mirrorRoot } = await repositoryWithCommandContestants("fixture");
    const generation = await createStubGeneration(mirrorRoot);
    await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      resumable: true,
      allowModelCalls: true,
    });
    const result = await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      resumable: true,
    });
    expect(result.contestants).toHaveLength(2);
  }, 60000);

  it("does not trigger for fixture-only generations", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-guard-fixture-");
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
    });
    expect(result.contestants).toHaveLength(3);
  }, 60000);

  it("runs an archived Phase 1 generation without profile.json or run-plan.json", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-guard-phase1-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const snapshotPath = join(generation.generationPath, "challenge/snapshot.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      inputHashes: Record<string, string>;
    };
    snapshot.inputHashes["config/contestants.yaml"] =
      snapshot.inputHashes["config/profiles/fixture/contestants.yaml"]!;
    snapshot.inputHashes["config/judges.yaml"] =
      snapshot.inputHashes["config/profiles/fixture/judges.yaml"]!;
    delete snapshot.inputHashes["config/profiles/fixture/contestants.yaml"];
    delete snapshot.inputHashes["config/profiles/fixture/judges.yaml"];
    delete snapshot.inputHashes["config/profile.json"];
    delete snapshot.inputHashes["run-plan.json"];
    await chmod(join(generation.generationPath, "challenge"), 0o755);
    await chmod(snapshotPath, 0o644);
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rm(join(generation.generationPath, "config/profile.json"));
    await rm(join(generation.generationPath, "run-plan.json"));

    const result = await runWaveB({
      repositoryRoot,
      generationPath: generation.generationPath,
    });
    expect(result.contestants).toHaveLength(3);
  }, 60000);

  it("does not treat a Phase 2 generation with a deleted profile artifact as legacy", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-guard-profile-tamper-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const profilePath = join(generation.generationPath, "config/profile.json");
    await chmod(join(generation.generationPath, "config"), 0o755);
    await rm(profilePath);

    await expect(
      runWaveB({ repositoryRoot, generationPath: generation.generationPath }),
    ).rejects.toThrow(
      "snapshot is missing the source hash for config/contestants.yaml",
    );
  });

  it("does not demand permission for a pending task whose contestant run is already terminal", async () => {
    const { mirrorRoot } = await repositoryWithCommandContestants("fixture");
    const generation = await createStubGeneration(mirrorRoot);
    await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      resumable: true,
      allowModelCalls: true,
    });
    const taskPath = join(generation.generationPath, "contestants/stub-one/task.json");
    const task = JSON.parse(await readFile(taskPath, "utf8")) as {
      status: string;
      completedAt: string | null;
      requestAccepted: boolean | null;
    };
    await writeFile(
      taskPath,
      `${JSON.stringify({ ...task, status: "pending", completedAt: null }, null, 2)}\n`,
      "utf8",
    );

    await expect(
      runWaveB({
        repositoryRoot: mirrorRoot,
        generationPath: generation.generationPath,
        resumable: true,
      }),
    ).resolves.toMatchObject({ contestants: expect.any(Array) });
  }, 60000);

  it("does not count missing task state when terminal contestant, judgment, and awards artifacts can resume", async () => {
    const { mirrorRoot } = await repositoryWithCommandContestants("command");
    const generation = await createStubGeneration(mirrorRoot);
    await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      resumable: true,
      allowModelCalls: true,
      judgeAdapterFactory: () => new FixtureJudgeAdapter(),
    });

    const anonymousMap = JSON.parse(
      await readFile(
        join(generation.generationPath, "judging/anonymous-map.json"),
        "utf8",
      ),
    ) as { entries: Array<{ contestantId: string; anonymousCandidateId: string }> };
    await Promise.all([
      ...anonymousMap.entries.map(({ contestantId, anonymousCandidateId }) =>
        Promise.all([
          rm(join(generation.generationPath, "contestants", contestantId, "task.json")),
          rm(
            join(
              generation.generationPath,
              "judging/stub-judge/tasks",
              `${anonymousCandidateId}.json`,
            ),
          ),
        ]),
      ),
      rm(join(generation.generationPath, "judging/stub-judge/awards-task.json")),
    ]);

    await expect(
      runWaveB({
        repositoryRoot: mirrorRoot,
        generationPath: generation.generationPath,
        resumable: true,
        judgeAdapterFactory: () => new FixtureJudgeAdapter(),
      }),
    ).resolves.toMatchObject({ contestants: expect.any(Array) });
  }, 60000);

  it("does not count missing judge or awards tasks for a non-renderable contestant", async () => {
    const { mirrorRoot } = await repositoryWithCommandContestants("command");
    const generation = await createStubGeneration(mirrorRoot);
    await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      resumable: true,
      allowModelCalls: true,
      judgeAdapterFactory: () => new FixtureJudgeAdapter(),
    });

    const anonymousMap = JSON.parse(
      await readFile(
        join(generation.generationPath, "judging/anonymous-map.json"),
        "utf8",
      ),
    ) as { entries: Array<{ contestantId: string; anonymousCandidateId: string }> };
    const failed = anonymousMap.entries[1]!;
    const validationPath = join(
      generation.generationPath,
      "contestants",
      failed.contestantId,
      "validation.json",
    );
    const validation = JSON.parse(await readFile(validationPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      validationPath,
      `${JSON.stringify({ ...validation, status: "render_failed" }, null, 2)}\n`,
    );
    await Promise.all([
      rm(
        join(
          generation.generationPath,
          "judging/stub-judge/tasks",
          `${failed.anonymousCandidateId}.json`,
        ),
      ),
      rm(
        join(
          generation.generationPath,
          "judging/stub-judge",
          `${failed.anonymousCandidateId}.json`,
        ),
      ),
      rm(join(generation.generationPath, "judging/stub-judge/awards-task.json")),
    ]);
    await writeFile(
      join(generation.generationPath, "judging/stub-judge/awards.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        generationId: "0001",
        judgeId: "stub-judge",
        awards: [],
      })}\n`,
    );

    await expect(
      runWaveB({
        repositoryRoot: mirrorRoot,
        generationPath: generation.generationPath,
        resumable: true,
        judgeAdapterFactory: () => new FixtureJudgeAdapter(),
      }),
    ).resolves.toMatchObject({ contestants: expect.any(Array) });
  }, 60000);

  it("requires consent when reusable awards name a non-renderable candidate", async () => {
    const { mirrorRoot } = await repositoryWithCommandContestants("command");
    const generation = await createStubGeneration(mirrorRoot);
    await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      resumable: true,
      allowModelCalls: true,
      judgeAdapterFactory: () => new FixtureJudgeAdapter(),
    });

    const anonymousMap = JSON.parse(
      await readFile(
        join(generation.generationPath, "judging/anonymous-map.json"),
        "utf8",
      ),
    ) as { entries: Array<{ contestantId: string; anonymousCandidateId: string }> };
    const failed = anonymousMap.entries[1]!;
    const validationPath = join(
      generation.generationPath,
      "contestants",
      failed.contestantId,
      "validation.json",
    );
    const validation = JSON.parse(await readFile(validationPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      validationPath,
      `${JSON.stringify({ ...validation, status: "render_failed" }, null, 2)}\n`,
    );
    await rm(join(generation.generationPath, "judging/stub-judge/awards-task.json"));
    await writeFile(
      join(generation.generationPath, "judging/stub-judge/awards.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        generationId: "0001",
        judgeId: "stub-judge",
        awards: [
          {
            label: "Wrong Eligible Identity",
            anonymousCandidateId: failed.anonymousCandidateId,
            rationale: "This award deliberately names an ineligible candidate.",
          },
        ],
      })}\n`,
    );

    await expect(
      runWaveB({
        repositoryRoot: mirrorRoot,
        generationPath: generation.generationPath,
        resumable: true,
      }),
    ).rejects.toThrow(/awards call\(s\) pending/);
  }, 60000);

  it("requires consent when a pending candidate task has a malformed judgment artifact", async () => {
    const { mirrorRoot } = await repositoryWithCommandContestants("command");
    const generation = await createStubGeneration(mirrorRoot);
    await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      resumable: true,
      allowModelCalls: true,
      judgeAdapterFactory: () => new FixtureJudgeAdapter(),
    });
    const anonymousMap = JSON.parse(
      await readFile(
        join(generation.generationPath, "judging/anonymous-map.json"),
        "utf8",
      ),
    ) as { entries: Array<{ anonymousCandidateId: string }> };
    const anonymousCandidateId = anonymousMap.entries[0]!.anonymousCandidateId;
    const taskPath = join(
      generation.generationPath,
      "judging/stub-judge/tasks",
      `${anonymousCandidateId}.json`,
    );
    const task = JSON.parse(await readFile(taskPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      taskPath,
      `${JSON.stringify({ ...task, status: "pending", completedAt: null }, null, 2)}\n`,
    );
    await writeFile(
      join(
        generation.generationPath,
        "judging/stub-judge",
        `${anonymousCandidateId}.json`,
      ),
      "{}\n",
    );

    await expect(
      runWaveB({
        repositoryRoot: mirrorRoot,
        generationPath: generation.generationPath,
        resumable: true,
      }),
    ).rejects.toThrow(/candidate-judging call\(s\) pending/);
  }, 60000);

  it("requires consent when a pending awards task has a malformed awards artifact", async () => {
    const { mirrorRoot } = await repositoryWithCommandContestants("command");
    const generation = await createStubGeneration(mirrorRoot);
    await runWaveB({
      repositoryRoot: mirrorRoot,
      generationPath: generation.generationPath,
      resumable: true,
      allowModelCalls: true,
      judgeAdapterFactory: () => new FixtureJudgeAdapter(),
    });
    const taskPath = join(
      generation.generationPath,
      "judging/stub-judge/awards-task.json",
    );
    const task = JSON.parse(await readFile(taskPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      taskPath,
      `${JSON.stringify({ ...task, status: "pending", completedAt: null }, null, 2)}\n`,
    );
    await writeFile(
      join(generation.generationPath, "judging/stub-judge/awards.json"),
      "{}\n",
    );

    await expect(
      runWaveB({
        repositoryRoot: mirrorRoot,
        generationPath: generation.generationPath,
        resumable: true,
      }),
    ).rejects.toThrow(/awards call\(s\) pending/);
  }, 60000);

  it("rejects a modified Phase 2 run-plan artifact", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-guard-plan-tamper-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const runPlanPath = join(generation.generationPath, "run-plan.json");
    await chmod(runPlanPath, 0o644);
    await writeFile(runPlanPath, "{}\n", "utf8");

    await expect(
      runWaveB({ repositoryRoot, generationPath: generation.generationPath }),
    ).rejects.toThrow("source input run-plan.json failed its canonical hash check");
  });

  it("rejects modified copied config bytes in an archived Phase 1 generation", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-guard-phase1-tamper-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-28T20:00:00.000Z",
    });
    const snapshotPath = join(generation.generationPath, "challenge/snapshot.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      inputHashes: Record<string, string>;
    };
    snapshot.inputHashes["config/contestants.yaml"] =
      snapshot.inputHashes["config/profiles/fixture/contestants.yaml"]!;
    snapshot.inputHashes["config/judges.yaml"] =
      snapshot.inputHashes["config/profiles/fixture/judges.yaml"]!;
    delete snapshot.inputHashes["config/profiles/fixture/contestants.yaml"];
    delete snapshot.inputHashes["config/profiles/fixture/judges.yaml"];
    delete snapshot.inputHashes["config/profile.json"];
    delete snapshot.inputHashes["run-plan.json"];
    await chmod(join(generation.generationPath, "challenge"), 0o755);
    await chmod(snapshotPath, 0o644);
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await chmod(join(generation.generationPath, "config"), 0o755);
    await rm(join(generation.generationPath, "config/profile.json"));
    await rm(join(generation.generationPath, "run-plan.json"));
    const contestantsPath = join(generation.generationPath, "config/contestants.yaml");
    await chmod(contestantsPath, 0o644);
    await writeFile(
      contestantsPath,
      `${await readFile(contestantsPath, "utf8")}\n`,
      "utf8",
    );

    await expect(
      runWaveB({ repositoryRoot, generationPath: generation.generationPath }),
    ).rejects.toThrow(
      "generation config/contestants.yaml failed its canonical hash check",
    );
  });
});
