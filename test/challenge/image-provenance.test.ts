import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

interface ProvenanceManifest {
  readonly schemaVersion: 1;
  readonly license: "MIT";
  readonly copyrightHolder: string;
  readonly maintainerAttestation: string;
  readonly assets: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}

const expectedPaths = [
  ...["001", "002", "003"].flatMap((season) =>
    ["01", "02", "03", "04", "05", "06"].map(
      (seed) => `challenge/season-${season}/seed/thumbnails/seed-${seed}.png`,
    ),
  ),
  "test/fixtures/reference/gallery-screenshot.png",
].sort();

describe("first-party image provenance", () => {
  it("covers and authenticates every bundled seed and reference image", async () => {
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, "assets/first-party-images.json"), "utf8"),
    ) as ProvenanceManifest;

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.license).toBe("MIT");
    expect(manifest.copyrightHolder).toBe("Ville Hellman");
    expect(manifest.maintainerAttestation.trim()).not.toBe("");
    expect(manifest.assets.map((asset) => asset.path).sort()).toEqual(expectedPaths);

    for (const asset of manifest.assets) {
      const bytes = await readFile(join(repositoryRoot, asset.path));
      expect(createHash("sha256").update(bytes).digest("hex"), asset.path).toBe(
        asset.sha256,
      );
    }
  });
});
