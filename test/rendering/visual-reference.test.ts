import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { createGeneration } from "../../src/artifacts/generation.js";
import { runGeneration } from "../../src/orchestration/generation.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const referencePath = join(
  repositoryRoot,
  "test/fixtures/reference/gallery-screenshot.png",
);
const generatedAt = "2026-08-28T20:00:00.000Z";

describe("static gallery visual reference", () => {
  it("stays within the documented M4/macOS pixel-difference threshold", async () => {
    let counter = 0;
    const deterministicRandom = (size: number): Buffer => {
      counter += 1;
      const buf = Buffer.alloc(size, 0x42);
      buf.writeUInt32BE(counter, 0);
      return buf;
    };
    const generationsRoot = await createTestTempRoot("local-maxima-visual-reference-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: generatedAt,
      randomBytes: deterministicRandom,
    });
    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt,
      clock: () => new Date(generatedAt),
      randomBytes: deterministicRandom,
    });
    const actualPath = result.gallery.screenshotPath;
    const [actual, reference] = await Promise.all([
      sharp(actualPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(referencePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    expect(actual.info.width).toBe(1280);
    expect(actual.info.height).toBeGreaterThanOrEqual(1200);
    expect(actual.info.height).toBeLessThanOrEqual(12000);
    expect(reference.info.width).toBe(actual.info.width);
    expect(reference.info.height).toBe(actual.info.height);
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
    expect(
      differentPixels / (actual.info.width * actual.info.height),
    ).toBeLessThanOrEqual(0.005);
    expect(maximumChannelDelta).toBeLessThanOrEqual(32);
    expect(await readFile(actualPath)).toBeTruthy();
  }, 30000);
});
