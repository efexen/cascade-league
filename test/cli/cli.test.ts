import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { normalizeSeasonId } from "../../src/cli/commands.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url).pathname;

interface GardenResult {
  readonly exitCode: number;
  readonly stderr: string;
}

async function runGarden(
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<GardenResult> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/cli/garden.ts", ...args],
      { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024, ...(env ? { env } : {}) },
    );
    return { exitCode: 0, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { exitCode: failure.code ?? 1, stderr: failure.stderr ?? "" };
  }
}

describe("garden CLI inputs", () => {
  it("accepts the documented three-digit season alias and stores a four-digit ID", () => {
    expect(normalizeSeasonId("001")).toBe("0001");
    expect(normalizeSeasonId("0001")).toBe("0001");
  });

  it("rejects ambiguous season identifiers", () => {
    expect(() => normalizeSeasonId("1")).toThrow();
    expect(() => normalizeSeasonId("01a")).toThrow();
    expect(() => normalizeSeasonId("00001")).toThrow();
  });

  it("exposes explicit replacement consent for static exports", async () => {
    const result = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/cli/garden.ts", "export-static", "--help"],
      { cwd: repositoryRoot },
    );
    expect(result.stdout).toContain("--replace-existing");
  });

  it("exposes the runnable Wave-B command", async () => {
    const result = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/cli/garden.ts", "--help"],
      { cwd: repositoryRoot },
    );
    expect(result.stdout).toContain("run-wave-b");
    expect(result.stdout).toContain("export-static");
    expect(result.stdout).toContain("Cascade League generation tools");
  });
});

describe("garden CLI profile requirement", () => {
  it("fails create-generation without --profile and lists the checked-in profiles", async () => {
    const result = await runGarden(["create-generation", "--season", "001"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--profile is required for create-generation");
    expect(result.stderr).toContain("checked-in profiles: fixture, real.example");
  });

  it("fails verify without --profile and lists the checked-in profiles", async () => {
    const result = await runGarden(["verify"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--profile is required for verify");
    expect(result.stderr).toContain("checked-in profiles: fixture, real.example");
  });

  it("fails the creation paths of run-generation and run-wave-b without --profile", async () => {
    for (const command of ["run-generation", "run-wave-b"]) {
      const result = await runGarden([command, "--season", "001"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`--profile is required for ${command}`);
      expect(result.stderr).toContain("checked-in profiles: fixture, real.example");
    }
  }, 15000);
});

describe("garden CLI real.example template profile", () => {
  it("verify --profile real.example passes schema checks and reports only the by-design placeholder issues", async () => {
    // Hermetic operator environment: the template allowlists these two
    // credential names, so the subprocess must not see them.
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.EXAMPLE_API_KEY;
    delete environment.SECOND_EXAMPLE_API_KEY;
    const result = await runGarden(
      ["verify", "--profile", "real.example"],
      environment,
    );
    const issueLines = result.stderr
      .split("\n")
      .filter((line) => /^\[(error|warning)\] /.test(line));
    const parsed = issueLines.map((line) => {
      const match = /^\[(error|warning)\] ([a-z_]+): (.*)$/.exec(line);
      expect(match, line).not.toBeNull();
      return {
        severity: match![1] as "error" | "warning",
        code: match![2]!,
        message: match![3]!,
      };
    });

    const byCode = (code: string, severity?: "error" | "warning") =>
      parsed.filter(
        (entry) =>
          entry.code === code &&
          (severity === undefined || entry.severity === severity),
      );

    // No profile resolution or schema failures are tolerated.
    expect(byCode("profile_resolution")).toHaveLength(0);

    // The template declares two enabled contestants and one enabled judge,
    // all command adapters with deliberately fake absolute executables.
    const executables = byCode("command_executable", "error");
    expect(executables).toHaveLength(3);
    for (const error of executables) {
      expect(error.message).toContain("/absolute/path/to/");
    }
    expect(
      executables.map((error) =>
        error.message.slice(0, error.message.indexOf(" executable")),
      ),
    ).toEqual([
      "example-harness-example-model",
      "second-example-harness-second-example-model",
      "example-vision-judge",
    ]);

    // The placeholder credential names are not present in the operator
    // environment: one per allowlisting entry.
    const envMissing = byCode("environment_variable", "error");
    expect(envMissing).toHaveLength(3);
    expect(
      envMissing.filter((entry) => /\bEXAMPLE_API_KEY\b/.test(entry.message)),
    ).toHaveLength(2);
    expect(
      envMissing.filter((entry) => entry.message.includes("SECOND_EXAMPLE_API_KEY")),
    ).toHaveLength(1);

    // Every enabled command entry carries deliberately generic
    // record-at-run-time / pinned-or-recorded placeholders for both versions.
    const generic = byCode("version_genericity", "error");
    expect(generic).toHaveLength(6);
    const genericText = generic.map((entry) => entry.message).join("\n");
    expect(genericText).toContain("record-at-run-time");
    expect(genericText).toContain("pinned-or-recorded");

    // The second example contestant is deliberately prompt-only.
    const promptOnly = byCode("one_shot_prompt_only", "warning");
    expect(promptOnly).toHaveLength(1);
    expect(promptOnly[0]!.message).toContain(
      "second-example-harness-second-example-model",
    );

    // Everything else must be a warning, and only of the known kinds.
    for (const warning of parsed.filter((entry) => entry.severity === "warning")) {
      expect(["node_version", "one_shot_prompt_only"]).toContain(warning.code);
    }
    expect(result.exitCode).toBe(1);
  });
});
