import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { createGeneration } from "../../src/artifacts/generation.js";
import { runGeneration } from "../../src/orchestration/generation.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const referencePath = join(
  repositoryRoot,
  "test/fixtures/reference/gallery-screenshot.png",
);
const generatedAt = "2026-08-28T20:00:00.000Z";

describe("static gallery visual reference", () => {
  it("stays within the documented M4/macOS pixel-difference threshold", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-visual-reference-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: generatedAt,
    });
    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt,
      clock: () => new Date(generatedAt),
    });
    const actualPath = result.gallery.screenshotPath;
    const [actual, reference] = await Promise.all([
      sharp(actualPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(referencePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    expect(actual.info.width).toBe(1440);
    expect(actual.info.height).toBe(1200);
    expect(reference.info.width).toBe(1440);
    expect(reference.info.height).toBe(1200);
    expect(actual.data.byteLength).toBe(reference.data.byteLength);
    let differentPixels = 0;
    let maximumChannelDelta = 0;
    for (let offset = 0; offset < actual.data.length; offset += 4) {
      let pixelDifferent = false;
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(
          actual.data[offset + channel]! - reference.data[offset + channel]!,
        );
        maximumChannelDelta = Math.max(maximumChannelDelta, delta);
        if (delta > 8) pixelDifferent = true;
      }
      if (pixelDifferent) differentPixels += 1;
    }
    expect(differentPixels / (1440 * 1200)).toBeLessThanOrEqual(0.005);
    expect(maximumChannelDelta).toBeLessThanOrEqual(32);
    expect(await readFile(actualPath)).toBeTruthy();
  }, 30000);
});
