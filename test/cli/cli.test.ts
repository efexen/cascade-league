import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { normalizeSeasonId } from "../../src/cli/commands.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url).pathname;

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
