import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import {
  commandContestant,
  commandJudge,
  contestantsDocument,
  judgesDocument,
} from "../helpers/profile-documents.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url).pathname;

interface GardenResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGarden(
  args: string[],
  cwd: string = repositoryRoot,
  env?: NodeJS.ProcessEnv,
): Promise<GardenResult> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/cli/garden.ts", ...args],
      { cwd, maxBuffer: 4 * 1024 * 1024, ...(env ? { env } : {}) },
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

async function directoryIsEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function repositoryWithCommandProfile(
  profileId: string,
  promptOnly: boolean,
): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "local-maxima-plan-cli-repo-"));
  const copy = join(parent, "repository");
  await cp(repositoryRoot, copy, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${join("", "node_modules")}/`) &&
      !source.endsWith(`${join("", "node_modules")}`),
  });
  await symlink(join(repositoryRoot, "node_modules"), join(copy, "node_modules"));
  const profileRoot = join(copy, "config", "profiles", profileId);
  await mkdir(profileRoot, { recursive: true });
  const offlineArgv = [
    process.execPath,
    "-e",
    "process.exit(0)",
    "{promptPath}",
    "{submissionPath}",
    "{usageOutputPath}",
  ];
  await writeFile(
    join(profileRoot, "contestants.yaml"),
    stringifyYaml(
      contestantsDocument([
        commandContestant("stub-one", {
          harness: {
            name: "stub-harness",
            version: "0.0.1",
            adapter: "command",
            command: { argv: offlineArgv, environmentAllowlist: [] },
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
              argv: [
                process.execPath,
                "-e",
                "process.exit(0)",
                "{promptPath}",
                "{submissionPath}",
              ],
              environmentAllowlist: [],
            },
          },
        }),
      ]),
    ),
  );
  await writeFile(
    join(profileRoot, "judges.yaml"),
    stringifyYaml(
      judgesDocument([
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
      ]),
    ),
  );
  return copy;
}

describe("garden plan-generation", () => {
  it("requires --profile", async () => {
    const result = await runGarden(["plan-generation", "--season", "001"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--profile is required for plan-generation");
  });

  it("prints the full fixture plan with C=3, J=2, and a maximum of 11 calls", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-plan-gens-"));
    const result = await runGarden([
      "plan-generation",
      "--season",
      "001",
      "--profile",
      "fixture",
      "--generations-root",
      generationsRoot,
    ]);
    expect(result.exitCode).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("season 0001");
    expect(output).toContain("generation 0001");
    expect(output).toContain('profile "fixture"');
    expect(output).toContain("fixture-editorial");
    expect(output).toContain("fixture-critic-a");
    expect(output).toContain("external model calls required: no");
    expect(output).toContain("contestant calls: 3");
    expect(output).toContain("candidate-judging calls: 6");
    expect(output).toContain("awards calls: 2");
    expect(output).toContain("maximum total calls: 11");
    expect(output).toContain("timeoutMs=480000");
    expect(output).toContain("maximumOutputTokens=4000");
    expect(output).toContain("prompt-only one-shot contestants: none");
    const plan = JSON.parse(
      result.stdout.slice(
        result.stdout.indexOf("{", result.stdout.indexOf("run-plan")),
      ),
    ) as {
      callCounts: { maximumTotalCalls: number };
      externalModelCallsRequired: boolean;
    };
    expect(plan.callCounts.maximumTotalCalls).toBe(11);
    expect(plan.externalModelCallsRequired).toBe(false);
  });

  it("writes nothing to disk", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-plan-gens-"));
    const result = await runGarden([
      "plan-generation",
      "--season",
      "001",
      "--profile",
      "fixture",
      "--generations-root",
      generationsRoot,
    ]);
    expect(result.exitCode).toBe(0);
    expect(await directoryIsEmpty(generationsRoot)).toBe(true);
  });

  it("exits nonzero when preflight reports errors, listing the issues", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-plan-gens-"));
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.EXAMPLE_API_KEY;
    delete environment.SECOND_EXAMPLE_API_KEY;
    const result = await runGarden(
      [
        "plan-generation",
        "--season",
        "001",
        "--profile",
        "real.example",
        "--generations-root",
        generationsRoot,
      ],
      repositoryRoot,
      environment,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("command_executable");
    expect(result.stderr).toContain("version_genericity");
    expect(await directoryIsEmpty(generationsRoot)).toBe(true);
  });

  it("refuses a prompt-only command contestant unless accepted, without --allow-model-calls", async () => {
    const copy = await repositoryWithCommandProfile("promptonly", true);
    const generationsRoot = join(copy, "plan-generations");
    const refused = await runGarden(
      [
        "plan-generation",
        "--season",
        "001",
        "--profile",
        "promptonly",
        "--generations-root",
        generationsRoot,
      ],
      copy,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("stub-one");
    expect(refused.stderr).toContain("--accept-prompt-only-one-shot");
    expect(await directoryIsEmpty(generationsRoot)).toBe(true);

    const accepted = await runGarden(
      [
        "plan-generation",
        "--season",
        "001",
        "--profile",
        "promptonly",
        "--generations-root",
        generationsRoot,
        "--accept-prompt-only-one-shot",
      ],
      copy,
    );
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain("external model calls required: yes");
    expect(accepted.stdout).toContain("contestant calls: 2");
    expect(accepted.stdout).toContain("candidate-judging calls: 2");
    expect(accepted.stdout).toContain("maximum total calls: 5");
    expect(accepted.stdout).toContain("stub-two");
    expect(accepted.stdout).toContain("prompt-only one-shot contestants: stub-one");
    const plan = JSON.parse(
      accepted.stdout.slice(
        accepted.stdout.indexOf("{", accepted.stdout.indexOf("run-plan")),
      ),
    ) as {
      promptOnlyOneShotAccepted: boolean;
      externalModelCallsRequired: boolean;
      usageReportingUnsupported: string[];
    };
    expect(plan.promptOnlyOneShotAccepted).toBe(true);
    expect(plan.externalModelCallsRequired).toBe(true);
    expect(plan.usageReportingUnsupported).toEqual(["stub-two", "stub-judge"]);
    expect(await directoryIsEmpty(generationsRoot)).toBe(true);
  }, 30000);

  it("uses the same noninteractive acceptance flag for create-generation", async () => {
    const repository = await repositoryWithCommandProfile("prompt-create", true);
    const generationsRoot = join(
      await mkdtemp(join(tmpdir(), "local-maxima-create-cli-")),
      "generations",
    );
    const refused = await runGarden(
      [
        "create-generation",
        "--season",
        "001",
        "--profile",
        "prompt-create",
        "--generation",
        "0001",
        "--generations-root",
        generationsRoot,
      ],
      repository,
    );
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/prompt-only.*accept/i);

    const accepted = await runGarden(
      [
        "create-generation",
        "--season",
        "001",
        "--profile",
        "prompt-create",
        "--generation",
        "0001",
        "--generations-root",
        generationsRoot,
        "--accept-prompt-only-one-shot",
      ],
      repository,
    );
    expect(accepted.exitCode).toBe(0);
    const plan = JSON.parse(
      await readFile(join(generationsRoot, "0001/run-plan.json"), "utf8"),
    ) as { promptOnlyOneShotAccepted: boolean };
    expect(plan.promptOnlyOneShotAccepted).toBe(true);
  }, 30000);

  it("plans a season-2 generation after a completed previous generation", async () => {
    const copy = await repositoryWithCommandProfile("twoc", false);
    const generationsRoot = join(copy, "generations");
    const created = await runGarden(
      [
        "create-generation",
        "--season",
        "001",
        "--profile",
        "twoc",
        "--generations-root",
        generationsRoot,
      ],
      copy,
    );
    expect(created.exitCode).toBe(0);
    const planned = await runGarden(
      [
        "plan-generation",
        "--season",
        "001",
        "--profile",
        "twoc",
        "--generations-root",
        generationsRoot,
      ],
      copy,
    );
    expect(planned.exitCode).toBe(1);
    expect(planned.stderr).toContain("previous generation 0001 is not completed");

    // Complete the first generation by rewriting its manifest status.
    const manifestPath = join(generationsRoot, "0001", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      status: string;
      completedAt: string | null;
    };
    manifest.status = "completed";
    manifest.completedAt = "2026-08-28T21:00:00.000Z";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const plannedAgain = await runGarden(
      [
        "plan-generation",
        "--season",
        "001",
        "--profile",
        "twoc",
        "--generations-root",
        generationsRoot,
      ],
      copy,
    );
    expect(plannedAgain.exitCode).toBe(0);
    expect(plannedAgain.stdout).toContain("generation 0002");
  }, 30000);
});
