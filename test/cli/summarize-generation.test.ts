import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { cp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { createGeneration } from "../../src/artifacts/generation.js";
import { runGeneration } from "../../src/orchestration/generation.js";
import { RunSummarySchema } from "../../src/schemas/index.js";
import { RUN_SUMMARY_FILE_NAME } from "../../src/summarize/index.js";
import {
  commandContestant,
  contestantsDocument,
  fixtureJudge,
  judgesDocument,
} from "../helpers/profile-documents.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url).pathname;

interface GardenResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGarden(args: string[], cwd: string): Promise<GardenResult> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/cli/garden.ts", ...args],
      { cwd, maxBuffer: 4 * 1024 * 1024 },
    );
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("garden summarize-generation", () => {
  it("requires exactly one generation location form", async () => {
    const missing = await runGarden(["summarize-generation"], repositoryRoot);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("provide --generation or --generation-path");

    const both = await runGarden(
      [
        "summarize-generation",
        "--generation",
        "0001",
        "--generation-path",
        "/tmp/unused",
      ],
      repositoryRoot,
    );
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain(
      "use either --generation or --generation-path, not both",
    );
  }, 30000);

  it("does not offer or require model-call consent", async () => {
    const help = await runGarden(["summarize-generation", "--help"], repositoryRoot);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--generation ");
    expect(help.stdout).toContain("--generation-path");
    expect(help.stdout).toContain("--generations-root");
    expect(help.stdout).not.toContain("--allow-model-calls");
    expect(help.stdout).not.toContain("--profile");

    const rejected = await runGarden(
      [
        "summarize-generation",
        "--generation-path",
        "/tmp/unused",
        "--allow-model-calls",
      ],
      repositoryRoot,
    );
    expect(rejected.exitCode).not.toBe(0);
  }, 30000);

  it("regenerates byte-identical summaries through both location forms", async () => {
    const root = await createTestTempRoot("local-maxima-summary-cli-");
    const generationsRoot = join(root, "generations");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-30T10:00:00.000Z",
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
    });
    const summaryPath = join(generation.generationPath, RUN_SUMMARY_FILE_NAME);
    const original = await readFile(summaryPath);

    await rm(summaryPath);
    const byId = await runGarden(
      [
        "summarize-generation",
        "--generation",
        "0001",
        "--generations-root",
        generationsRoot,
      ],
      repositoryRoot,
    );
    expect(byId.exitCode).toBe(0);
    expect(byId.stdout).toContain(`run-summary: ${summaryPath}`);
    expect(await readFile(summaryPath)).toEqual(original);

    await rm(summaryPath);
    const byPath = await runGarden(
      ["summarize-generation", "--generation-path", generation.generationPath],
      repositoryRoot,
    );
    expect(byPath.exitCode).toBe(0);
    expect(byPath.stdout).toContain(`run-summary: ${summaryPath}`);
    expect(await readFile(summaryPath)).toEqual(original);
  }, 180000);

  it("returns nonzero with a bounded clear error for a generation mismatch", async () => {
    const root = await createTestTempRoot("local-maxima-summary-cli-tamper-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot: join(root, "generations"),
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: "2026-08-30T10:00:00.000Z",
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
    });
    const summaryPath = join(generation.generationPath, RUN_SUMMARY_FILE_NAME);
    const original = await readFile(summaryPath);

    const leaderboardPath = join(generation.generationPath, "leaderboard.json");
    const leaderboard = JSON.parse(await readFile(leaderboardPath, "utf8")) as {
      generationId: string;
    };
    leaderboard.generationId = "9999";
    await writeFile(
      leaderboardPath,
      `${JSON.stringify(leaderboard, null, 2)}\n`,
      "utf8",
    );

    const refused = await runGarden(
      ["summarize-generation", "--generation-path", generation.generationPath],
      repositoryRoot,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("summarize-generation failed");
    expect(refused.stderr).toContain("run summary rejected leaderboard generation ID");
    // Bounded: a readable single failure, not an unbounded dump.
    expect(Buffer.byteLength(refused.stderr, "utf8")).toBeLessThan(2048);
    expect(await readFile(summaryPath)).toEqual(original);
  }, 180000);

  it("invokes no adapters and needs no consent for a command-backed generation whose work is durable", async () => {
    const parent = await createTestTempRoot("local-maxima-summary-command-");
    const copy = join(parent, "repository");
    await cp(repositoryRoot, copy, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${join("", "node_modules")}/`) &&
        !source.endsWith(`${join("", "node_modules")}`),
    });
    await symlink(join(repositoryRoot, "node_modules"), join(copy, "node_modules"));
    const counterPath = join(parent, "adapter-calls.txt");
    const editorialCss = await readFile(
      join(repositoryRoot, "test/fixtures/contestants/editorial.css"),
      "utf8",
    );
    await writeFile(
      join(copy, "counting-contestant.mjs"),
      [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(counterPath)}, "call\\n");`,
        `writeFileSync(process.argv[2], ${JSON.stringify(editorialCss)});`,
        "",
      ].join("\n"),
      "utf8",
    );
    const profileRoot = join(copy, "config", "profiles", "counting");
    await mkdir(profileRoot, { recursive: true });
    const stubArgv = [
      process.execPath,
      join(copy, "counting-contestant.mjs"),
      "{submissionPath}",
      "{promptPath}",
    ];
    await writeFile(
      join(profileRoot, "contestants.yaml"),
      stringifyYaml(
        contestantsDocument([
          commandContestant("counting-one", {
            harness: {
              name: "counting-harness",
              version: "0.0.1",
              adapter: "command",
              command: { argv: stubArgv, environmentAllowlist: [] },
            },
          }),
          commandContestant("counting-two", {
            harness: {
              name: "counting-harness",
              version: "0.0.1",
              adapter: "command",
              command: { argv: stubArgv, environmentAllowlist: [] },
            },
          }),
        ]),
      ),
    );
    await writeFile(
      join(profileRoot, "judges.yaml"),
      stringifyYaml(judgesDocument([fixtureJudge("fixture-critic-a")])),
    );

    const generationsRoot = join(copy, "generations");
    const created = await runGarden(
      [
        "create-generation",
        "--season",
        "001",
        "--profile",
        "counting",
        "--generations-root",
        generationsRoot,
      ],
      copy,
    );
    expect(created.exitCode).toBe(0);
    const generationPath = join(generationsRoot, "0001");

    // Make all command work durable with an explicit consent grant.
    const granted = await runGarden(
      ["run-wave-b", "--generation-path", generationPath, "--allow-model-calls"],
      copy,
    );
    expect(granted.exitCode).toBe(0);
    const callsAfterRun = (await readFile(counterPath, "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(callsAfterRun).toHaveLength(2);

    // Summarizing the durable command-backed generation requires no consent
    // and must not invoke the command adapter again.
    const summary = await runGarden(
      ["summarize-generation", "--generation-path", generationPath],
      copy,
    );
    expect(summary.exitCode).toBe(0);
    expect(summary.stdout).toContain(
      `run-summary: ${join(generationPath, RUN_SUMMARY_FILE_NAME)}`,
    );
    expect(summary.stderr).not.toContain("--allow-model-calls");
    const callsAfterSummary = (await readFile(counterPath, "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(callsAfterSummary).toHaveLength(2);

    const written = await readFile(join(generationPath, RUN_SUMMARY_FILE_NAME), "utf8");
    const parsed = RunSummarySchema.parse(JSON.parse(written) as unknown);
    expect(parsed.generationId).toBe("0001");
    expect(parsed.contestants.map((entry) => entry.contestantId)).toEqual([
      "counting-one",
      "counting-two",
    ]);

    // Regeneration is byte-identical.
    await rm(join(generationPath, RUN_SUMMARY_FILE_NAME));
    const again = await runGarden(
      ["summarize-generation", "--generation-path", generationPath],
      copy,
    );
    expect(again.exitCode).toBe(0);
    expect(await readFile(join(generationPath, RUN_SUMMARY_FILE_NAME), "utf8")).toBe(
      written,
    );
    expect(
      (await readFile(counterPath, "utf8")).split("\n").filter(Boolean),
    ).toHaveLength(2);
  }, 300000);
});
