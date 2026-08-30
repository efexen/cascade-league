import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { ManifestSchema } from "../../src/schemas/index.js";
import {
  commandContestant,
  contestantsDocument,
  fixtureJudge,
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
): Promise<GardenResult> {
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

/**
 * A repository copy whose "stub" profile runs two offline command
 * contestants (a Node script writing the editorial fixture stylesheet) with
 * a fixture judge. No paid model call is possible from these entries.
 */
async function repositoryWithCommandProfile(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "local-maxima-guard-cli-repo-"));
  const copy = join(parent, "repository");
  await cp(repositoryRoot, copy, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${join("", "node_modules")}/`) &&
      !source.endsWith(`${join("", "node_modules")}`),
  });
  await symlink(join(repositoryRoot, "node_modules"), join(copy, "node_modules"));
  const editorialCss = await readFile(
    join(repositoryRoot, "test/fixtures/contestants/editorial.css"),
    "utf8",
  );
  await writeFile(
    join(copy, "stub-contestant.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], ${JSON.stringify(editorialCss)});\n`,
    "utf8",
  );
  const profileRoot = join(copy, "config", "profiles", "stub");
  await mkdir(profileRoot, { recursive: true });
  const stubArgv = [
    process.execPath,
    join(copy, "stub-contestant.mjs"),
    "{submissionPath}",
    "{promptPath}",
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
            command: { argv: stubArgv, environmentAllowlist: [] },
          },
        }),
        commandContestant("stub-two", {
          harness: {
            name: "stub-harness",
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
  return copy;
}

async function createStubGeneration(
  copy: string,
): Promise<{ generationsRoot: string; generationPath: string }> {
  const generationsRoot = join(copy, "generations");
  const created = await runGarden(
    [
      "create-generation",
      "--season",
      "001",
      "--profile",
      "stub",
      "--generations-root",
      generationsRoot,
    ],
    copy,
  );
  expect(created.exitCode).toBe(0);
  return { generationsRoot, generationPath: join(generationsRoot, "0001") };
}

async function manifestStatus(generationPath: string): Promise<string> {
  return ManifestSchema.parse(
    JSON.parse(
      await readFile(join(generationPath, "manifest.json"), "utf8"),
    ) as unknown,
  ).status;
}

describe("garden --allow-model-calls wiring", () => {
  it("registers --allow-model-calls on run-generation, run-wave-b, and resume-generation", async () => {
    for (const command of ["run-generation", "run-wave-b", "resume-generation"]) {
      const result = await runGarden([command, "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--allow-model-calls");
    }
  });

  it("run-generation refuses a command generation without the flag and mutates nothing", async () => {
    const copy = await repositoryWithCommandProfile();
    const { generationPath } = await createStubGeneration(copy);
    const refused = await runGarden(
      ["run-generation", "--generation-path", generationPath],
      copy,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(
      "generation 0001 may make external model calls: 2 contestant call(s) pending; rerun with --allow-model-calls",
    );
    expect(await manifestStatus(generationPath)).toBe("created");
  }, 30000);

  it("run-wave-b completes a command generation when granted", async () => {
    const copy = await repositoryWithCommandProfile();
    const { generationPath } = await createStubGeneration(copy);
    const waveB = await runGarden(
      ["run-wave-b", "--generation-path", generationPath, "--allow-model-calls"],
      copy,
    );
    expect(waveB.exitCode).toBe(0);
    expect(waveB.stdout).toContain("Wave-B complete");
    expect(await manifestStatus(generationPath)).toBe("judging_complete");
  }, 180000);

  it("resume-generation refuses pending command calls without the flag and completes when granted", async () => {
    const copy = await repositoryWithCommandProfile();
    const { generationPath } = await createStubGeneration(copy);
    const refused = await runGarden(
      ["resume-generation", "--generation-path", generationPath],
      copy,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(
      "generation 0001 may make external model calls: 2 contestant call(s) pending; rerun with --allow-model-calls",
    );
    expect(await manifestStatus(generationPath)).toBe("created");
    await expect(
      readFile(join(generationPath, "contestants/stub-one/task.json"), "utf8"),
    ).rejects.toThrow();

    const granted = await runGarden(
      ["resume-generation", "--generation-path", generationPath, "--allow-model-calls"],
      copy,
    );
    expect(granted.exitCode).toBe(0);
    expect(await manifestStatus(generationPath)).toBe("completed");
  }, 240000);
});
