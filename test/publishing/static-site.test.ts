import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createGeneration } from "../../src/artifacts/generation.js";
import { runGeneration } from "../../src/orchestration/generation.js";
import { exportGenerationToStaticSite } from "../../src/publishing/static-site.js";
import { ManifestSchema } from "../../src/schemas/index.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const timestamp = "2026-09-06T19:30:00.000Z";

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(relativePath = ""): Promise<void> {
    const entries = await readdir(join(root, relativePath), { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const child = join(relativePath, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        hash.update(child);
        hash.update(await readFile(join(root, child)));
      }
    }
  }
  await visit();
  return hash.digest("hex");
}

describe("static publication export", () => {
  it("exports a completed generation as a deterministic functional static site", async () => {
    const generationsRoot = await createTestTempRoot("cascade-publish-generations-");
    const siteRoot = await createTestTempRoot("cascade-publish-site-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: timestamp,
    });
    const sourceHash = await hashTree(generation.generationPath);

    const first = await exportGenerationToStaticSite({
      repositoryRoot,
      generationPath: generation.generationPath,
      siteRoot,
    });
    const firstHash = await hashTree(siteRoot);
    const generationIndex = await readFile(
      join(first.publicPath, "index.html"),
      "utf8",
    );
    const catalog = JSON.parse(
      await readFile(join(siteRoot, "catalog.json"), "utf8"),
    ) as {
      generations: Array<{ seasonId: string; generationId: string; path: string }>;
    };

    expect(first).toMatchObject({ seasonId: "0001", generationId: "0001" });
    expect(generationIndex).toContain('href="designs/fixture-editorial/index.html"');
    await expect(
      readFile(join(first.publicPath, "designs/fixture-editorial/submission.css")),
    ).resolves.toEqual(
      await readFile(
        join(generation.generationPath, "contestants/fixture-editorial/sanitised.css"),
      ),
    );
    expect(catalog.generations).toEqual([
      {
        seasonId: "0001",
        generationId: "0001",
        path: "seasons/0001/0001/index.html",
      },
    ]);
    await expect(readFile(join(siteRoot, ".nojekyll"), "utf8")).resolves.toBe("");
    await expect(
      readFile(join(first.publicPath, "fonts/OFL-1.1.txt"), "utf8"),
    ).resolves.toContain("SIL OPEN FONT LICENSE");
    await expect(readFile(join(siteRoot, "index.html"), "utf8")).resolves.toContain(
      "Season 001 · Generation 0001",
    );

    await exportGenerationToStaticSite({
      repositoryRoot,
      generationPath: generation.generationPath,
      siteRoot,
    });
    expect(await hashTree(siteRoot)).toBe(firstHash);
    expect(await hashTree(generation.generationPath)).toBe(sourceHash);
  }, 30000);

  it("refuses to replace a different run at an occupied publication key without changing the site", async () => {
    const firstGenerationsRoot = await createTestTempRoot(
      "cascade-publish-first-generations-",
    );
    const secondGenerationsRoot = await createTestTempRoot(
      "cascade-publish-second-generations-",
    );
    const siteRoot = await createTestTempRoot("cascade-publish-collision-site-");
    const firstGeneration = await createGeneration({
      repositoryRoot,
      generationsRoot: firstGenerationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    // Independent generations can be created in the same millisecond. Their
    // cryptographic publication nonces still make them distinct sources.
    const secondTimestamp = timestamp;
    const secondGeneration = await createGeneration({
      repositoryRoot,
      generationsRoot: secondGenerationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: secondTimestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: firstGeneration.generationPath,
      generatedAt: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: secondGeneration.generationPath,
      generatedAt: secondTimestamp,
    });
    await exportGenerationToStaticSite({
      repositoryRoot,
      generationPath: firstGeneration.generationPath,
      siteRoot,
    });
    const before = await hashTree(siteRoot);

    await expect(
      exportGenerationToStaticSite({
        repositoryRoot,
        generationPath: secondGeneration.generationPath,
        siteRoot,
      }),
    ).rejects.toThrow(
      /occupied by source sha256:[a-f0-9]{64}; new source sha256:[a-f0-9]{64}; pass --replace-existing/iu,
    );
    expect(await hashTree(siteRoot)).toBe(before);
  }, 60000);

  it("replaces a different run only with explicit consent", async () => {
    const firstGenerationsRoot = await createTestTempRoot(
      "cascade-publish-replace-first-",
    );
    const secondGenerationsRoot = await createTestTempRoot(
      "cascade-publish-replace-second-",
    );
    const siteRoot = await createTestTempRoot("cascade-publish-replace-site-");
    const firstGeneration = await createGeneration({
      repositoryRoot,
      generationsRoot: firstGenerationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    const secondTimestamp = "2026-09-06T19:32:00.000Z";
    const secondGeneration = await createGeneration({
      repositoryRoot,
      generationsRoot: secondGenerationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: secondTimestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: firstGeneration.generationPath,
      generatedAt: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: secondGeneration.generationPath,
      generatedAt: secondTimestamp,
    });
    await exportGenerationToStaticSite({
      repositoryRoot,
      generationPath: firstGeneration.generationPath,
      siteRoot,
    });
    const before = await hashTree(siteRoot);

    await expect(
      exportGenerationToStaticSite({
        repositoryRoot,
        generationPath: secondGeneration.generationPath,
        siteRoot,
        replaceExisting: true,
      }),
    ).resolves.toMatchObject({
      seasonId: "0001",
      generationId: "0001",
      sourceIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      replacedSourceIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(await hashTree(siteRoot)).not.toBe(before);
    await expect(
      readFile(join(siteRoot, "seasons/0001/0001/metadata.json"), "utf8"),
    ).resolves.toContain(secondTimestamp);
  }, 60000);

  it("preserves the bounded root licence and notice files", async () => {
    const generationsRoot = await createTestTempRoot("cascade-publish-notices-");
    const siteRoot = await createTestTempRoot("cascade-publish-notices-site-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: timestamp,
    });
    const notices = [
      "LICENSE",
      "LICENSE.md",
      "LICENSE.txt",
      "NOTICE",
      "NOTICE.md",
      "NOTICE.txt",
    ] as const;
    for (const [index, name] of notices.entries()) {
      await writeFile(join(siteRoot, name), Buffer.from([0, index, 255, 10]));
    }

    await exportGenerationToStaticSite({
      repositoryRoot,
      generationPath: generation.generationPath,
      siteRoot,
    });

    for (const [index, name] of notices.entries()) {
      await expect(readFile(join(siteRoot, name))).resolves.toEqual(
        Buffer.from([0, index, 255, 10]),
      );
    }
  }, 30000);

  it("rejects an allowed root notice name when it is hard-linked", async () => {
    const generationsRoot = await createTestTempRoot("cascade-publish-notice-link-");
    const siteRoot = await createTestTempRoot("cascade-publish-notice-link-site-");
    const outsideRoot = await createTestTempRoot("cascade-publish-notice-link-source-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: timestamp,
    });
    const outsideNotice = join(outsideRoot, "notice.txt");
    await writeFile(outsideNotice, "linked notice\n", "utf8");
    await link(outsideNotice, join(siteRoot, "LICENSE"));
    const before = await hashTree(siteRoot);

    await expect(
      exportGenerationToStaticSite({
        repositoryRoot,
        generationPath: generation.generationPath,
        siteRoot,
      }),
    ).rejects.toThrow(/regular unlinked file/iu);
    expect(await hashTree(siteRoot)).toBe(before);
  }, 30000);

  it("refuses to publish inside an immutable generation", async () => {
    const generationsRoot = await createTestTempRoot("cascade-publish-nested-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: timestamp,
    });

    await expect(
      exportGenerationToStaticSite({
        repositoryRoot,
        generationPath: generation.generationPath,
        siteRoot: join(generation.generationPath, "publication"),
      }),
    ).rejects.toThrow(/separate|immutable/iu);
  }, 30000);

  it("refuses to publish a generation before terminal completion", async () => {
    const generationsRoot = await createTestTempRoot("cascade-publish-incomplete-");
    const siteRoot = await createTestTempRoot("cascade-publish-incomplete-site-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: timestamp,
    });
    const manifestPath = join(generation.generationPath, "manifest.json");
    const manifest = ManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(ManifestSchema.parse({ ...manifest, status: "gallery_complete" }), null, 2)}\n`,
      "utf8",
    );

    await expect(
      exportGenerationToStaticSite({
        repositoryRoot,
        generationPath: generation.generationPath,
        siteRoot,
      }),
    ).rejects.toThrow(/completed generation/iu);
  }, 30000);

  it("rejects symlinks in the publication catalog", async () => {
    const generationsRoot = await createTestTempRoot("cascade-publish-symlink-");
    const siteRoot = await createTestTempRoot("cascade-publish-symlink-site-");
    const outsideRoot = await createTestTempRoot("cascade-publish-symlink-outside-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: timestamp,
    });
    await exportGenerationToStaticSite({
      repositoryRoot,
      generationPath: generation.generationPath,
      siteRoot,
    });
    await symlink(outsideRoot, join(siteRoot, "seasons/9999"));

    await expect(
      exportGenerationToStaticSite({
        repositoryRoot,
        generationPath: generation.generationPath,
        siteRoot,
      }),
    ).rejects.toThrow(/symlink/iu);
  }, 30000);

  it("rejects a symlinked publication root without changing its target", async () => {
    const generationsRoot = await createTestTempRoot("cascade-publish-root-link-");
    const siteTarget = await createTestTempRoot("cascade-publish-root-target-");
    const linkParent = await createTestTempRoot("cascade-publish-root-parent-");
    const siteRoot = join(linkParent, "site");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: timestamp,
    });
    await symlink(siteTarget, siteRoot);
    const before = await hashTree(siteTarget);

    await expect(
      exportGenerationToStaticSite({
        repositoryRoot,
        generationPath: generation.generationPath,
        siteRoot,
      }),
    ).rejects.toThrow(/publication root.*symlink/iu);
    expect(await hashTree(siteTarget)).toBe(before);
  }, 30000);

  it("rejects unexpected publication paths without changing the checkout", async () => {
    const generationsRoot = await createTestTempRoot("cascade-publish-allowlist-");
    const siteRoot = await createTestTempRoot("cascade-publish-allowlist-site-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: timestamp,
    });
    await exportGenerationToStaticSite({
      repositoryRoot,
      generationPath: generation.generationPath,
      siteRoot,
    });
    await writeFile(join(siteRoot, "private.log"), "publication sentinel\n", "utf8");
    const before = await hashTree(siteRoot);

    await expect(
      exportGenerationToStaticSite({
        repositoryRoot,
        generationPath: generation.generationPath,
        siteRoot,
      }),
    ).rejects.toThrow(/unexpected publication path/iu);
    expect(await hashTree(siteRoot)).toBe(before);

    await rm(join(siteRoot, "private.log"));
    await mkdir(join(siteRoot, "docs"));
    await writeFile(join(siteRoot, "docs/LICENSE"), "nested notice\n", "utf8");
    const beforeNestedAttempt = await hashTree(siteRoot);
    await expect(
      exportGenerationToStaticSite({
        repositoryRoot,
        generationPath: generation.generationPath,
        siteRoot,
      }),
    ).rejects.toThrow(/unexpected publication path/iu);
    expect(await hashTree(siteRoot)).toBe(beforeNestedAttempt);
  }, 30000);
});
