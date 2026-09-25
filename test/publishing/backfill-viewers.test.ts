import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { backfillPublishedViewers } from "../../src/publishing/backfill-viewers.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cascade-viewer-backfill-"));
  const generation = join(root, "seasons", "0003", "0001");
  await mkdir(join(generation, "designs", "alpha"), { recursive: true });
  await mkdir(join(generation, "screenshots"), { recursive: true });
  await writeFile(
    join(generation, "metadata.json"),
    JSON.stringify({
      schemaVersion: 1,
      seasonId: "0003",
      generationId: "0001",
      generatedAt: "2026-09-06T11:07:59.794Z",
      stylesheetKind: "fallback",
      championContestantId: "alpha",
      championDisplayName: "Alpha",
      championReason: "Fixture.",
      expectedJudgeCount: 1,
      entries: [
        { contestantId: "alpha", displayName: "Alpha <&", rank: 1, status: "valid" },
      ],
    }),
  );
  await writeFile(
    join(generation, "index.html"),
    '<img src="screenshots/entry-001.png"><a href="designs/alpha/index.html">View full design</a>\n',
  );
  await writeFile(
    join(generation, "designs", "alpha", "index.html"),
    "raw design bytes\n",
  );
  await writeFile(join(generation, "screenshots", "entry-001.png"), "thumbnail");
  await writeFile(
    join(generation, "screenshots", "entry-001-full.png"),
    "full screenshot",
  );
  return root;
}

describe("published viewer backfill", () => {
  it("previews and applies an additive repeatable migration preserving unrelated bytes", async () => {
    const root = await fixture();
    const originalIndex = await readFile(join(root, "seasons/0003/0001/index.html"));
    const originalRaw = await readFile(
      join(root, "seasons/0003/0001/designs/alpha/index.html"),
    );
    const preview = await backfillPublishedViewers({
      sitePath: root,
      seasonId: "0003",
      dryRun: true,
    });
    expect(preview.changedFiles).toEqual([
      "seasons/0003/0001/designs/alpha/view.html",
      "seasons/0003/0001/index.html",
    ]);
    expect(await readFile(join(root, "seasons/0003/0001/index.html"))).toEqual(
      originalIndex,
    );

    const applied = await backfillPublishedViewers({
      sitePath: root,
      seasonId: "0003",
    });
    expect(applied.changedFiles).toEqual(preview.changedFiles);
    const updated = await readFile(join(root, "seasons/0003/0001/index.html"), "utf8");
    expect(updated).toContain('href="designs/alpha/view.html"');
    expect(updated).toContain('src="screenshots/entry-001.png"');
    const viewer = await readFile(
      join(root, "seasons/0003/0001/designs/alpha/view.html"),
      "utf8",
    );
    expect(viewer).toContain("Rank 1 · valid");
    expect(viewer).not.toContain("0.00");
    expect(viewer).toContain("screenshots/entry-001-full.png");
    expect(
      await readFile(join(root, "seasons/0003/0001/designs/alpha/index.html")),
    ).toEqual(originalRaw);
    const repeated = await backfillPublishedViewers({
      sitePath: root,
      seasonId: "0003",
    });
    expect(repeated.changedFiles).toEqual([]);
    expect(repeated.viewers).toBe(1);
  });

  it("refuses unexpected generation files before writing anything", async () => {
    const root = await fixture();
    const generation = join(root, "seasons/0003/0001");
    const before = await readFile(join(generation, "index.html"));
    await writeFile(join(generation, "mystery.json"), "unknown");
    await expect(
      backfillPublishedViewers({ sitePath: root, seasonId: "0003" }),
    ).rejects.toThrow("unexpected paths: mystery.json");
    expect(await readFile(join(generation, "index.html"))).toEqual(before);
  });

  it("refuses malformed metadata and gallery link order mismatches", async () => {
    const malformed = await fixture();
    await writeFile(join(malformed, "seasons/0003/0001/metadata.json"), "{}");
    await expect(
      backfillPublishedViewers({ sitePath: malformed, seasonId: "0003" }),
    ).rejects.toThrow("metadata is invalid");

    const mismatch = await fixture();
    const indexPath = join(mismatch, "seasons/0003/0001/index.html");
    const html = await readFile(indexPath, "utf8");
    await writeFile(
      indexPath,
      html.replace("designs/alpha/index.html", "designs/other/index.html"),
    );
    await expect(
      backfillPublishedViewers({ sitePath: mismatch, seasonId: "0003" }),
    ).rejects.toThrow("design links do not match published raw pages");
  });
});
