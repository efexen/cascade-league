import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url).pathname;

describe("garden CLI", () => {
  it("runs the documented fixture tournament command and prints both output paths", async () => {
    const outputRoot = await createTestTempRoot("local-maxima-cli-fixture-");
    const result = await execFileAsync(
      "pnpm",
      ["garden", "fixture-tournament", "--output-root", outputRoot],
      { cwd: repositoryRoot, maxBuffer: 1024 * 1024 },
    );
    const generationLine = result.stdout
      .split("\n")
      .find((line) => line.startsWith("generation: "));
    const galleryLine = result.stdout
      .split("\n")
      .find((line) => line.startsWith("gallery: "));
    expect(generationLine).toBeDefined();
    expect(galleryLine).toBeDefined();
    const generationPath = generationLine!.slice("generation: ".length);
    const manifest = JSON.parse(
      await readFile(join(generationPath, "manifest.json"), "utf8"),
    ) as { status: string };
    expect(manifest.status).toBe("completed");
    expect(galleryLine!.slice("gallery: ".length)).toBe(join(generationPath, "public"));
  }, 30000);
});
