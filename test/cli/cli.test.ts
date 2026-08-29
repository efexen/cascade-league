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

async function runGarden(...args: string[]): Promise<GardenResult> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/cli/garden.ts", ...args],
      { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 },
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

  it("exposes the runnable Wave-B command", async () => {
    const result = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/cli/garden.ts", "--help"],
      { cwd: repositoryRoot },
    );
    expect(result.stdout).toContain("run-wave-b");
  });
});

describe("garden CLI profile requirement", () => {
  it("fails create-generation without --profile and lists the checked-in profiles", async () => {
    const result = await runGarden("create-generation", "--season", "001");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--profile is required for create-generation");
    expect(result.stderr).toContain("checked-in profiles: fixture, real.example");
  });

  it("fails verify without --profile and lists the checked-in profiles", async () => {
    const result = await runGarden("verify");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--profile is required for verify");
    expect(result.stderr).toContain("checked-in profiles: fixture, real.example");
  });

  it("fails the creation paths of run-generation and run-wave-b without --profile", async () => {
    for (const command of ["run-generation", "run-wave-b"]) {
      const result = await runGarden(command, "--season", "001");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`--profile is required for ${command}`);
      expect(result.stderr).toContain("checked-in profiles: fixture, real.example");
    }
  });
});

describe("garden CLI real.example template profile", () => {
  it("verify --profile real.example passes schema checks and reports only placeholder executable errors", async () => {
    const result = await runGarden("verify", "--profile", "real.example");
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

    const errors = parsed.filter((entry) => entry.severity === "error");
    // The template declares two enabled contestants and one enabled judge,
    // all command adapters with deliberately fake absolute executables.
    expect(errors).toHaveLength(3);
    for (const error of errors) {
      expect(error.code).toBe("command_executable");
      expect(error.message).toContain("/absolute/path/to/");
    }
    expect(
      errors.map((error) =>
        error.message.slice(0, error.message.indexOf(" executable")),
      ),
    ).toEqual([
      "example-harness-example-model",
      "second-example-harness-second-example-model",
      "example-vision-judge",
    ]);
    // No profile resolution or schema failures are tolerated.
    expect(parsed.some((entry) => entry.code === "profile_resolution")).toBe(false);
    // Any remaining issues are warnings only (for example the Node reference
    // runtime notice on non-24 hosts).
    for (const warning of parsed.filter((entry) => entry.severity === "warning")) {
      expect(warning.code).toBe("node_version");
    }
    expect(result.exitCode).toBe(1);
  });
});
