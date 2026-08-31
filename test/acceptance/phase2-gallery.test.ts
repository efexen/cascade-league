import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { createGeneration } from "../../src/artifacts/generation.js";
import { buildGallery } from "../../src/gallery/builder.js";
import { runGeneration } from "../../src/orchestration/generation.js";
import {
  LeaderboardSchema,
  ManifestSchema,
  RunPlanSchema,
  RunSchema,
  RunSummarySchema,
  SnapshotSchema,
} from "../../src/schemas/index.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const timestamp = "2026-08-31T14:00:00.000Z";

async function filesUnder(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(directory, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

async function hashSourceTree(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const entries = await readdir(join(directory, prefix), { withFileTypes: true });
    for (const entry of entries) {
      if (prefix === "" && entry.name === "public") continue;
      if (prefix === "" && entry.name === "run-summary.json") continue;
      const path = join(prefix, entry.name);
      const absolutePath = join(directory, path);
      if (entry.isDirectory()) {
        await walk(directory, path);
      } else if (entry.isFile()) {
        hashes.set(
          relative(root, absolutePath),
          createHash("sha256")
            .update(await readFile(absolutePath))
            .digest("hex"),
        );
      }
    }
  };
  await walk(root);
  return hashes;
}

function matrixMarkup(html: string): string {
  const start = html.indexOf('<table class="judge-matrix">');
  const end = html.indexOf("</table>", start);
  if (start < 0 || end < 0) throw new Error("public judge matrix is missing");
  return html.slice(start, end + "</table>".length);
}

async function expectExactScreenshot(path: string): Promise<void> {
  await expect(sharp(path).metadata()).resolves.toMatchObject({
    format: "png",
    width: 1440,
    height: 1200,
  });
}

describe("Phase 2 gallery acceptance", () => {
  it("completes the offline fixture gallery with immutable, private, exact-size artifacts", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "local-maxima-phase2-gallery-"));
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot: join(outputRoot, "generations"),
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    const result = await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: timestamp,
    });

    const manifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(join(generation.generationPath, "manifest.json"), "utf8"),
      ) as unknown,
    );
    const leaderboard = LeaderboardSchema.parse(
      JSON.parse(
        await readFile(join(generation.generationPath, "leaderboard.json"), "utf8"),
      ) as unknown,
    );
    const runPlan = RunPlanSchema.parse(
      JSON.parse(
        await readFile(join(generation.generationPath, "run-plan.json"), "utf8"),
      ) as unknown,
    );
    const runSummary = RunSummarySchema.parse(
      JSON.parse(await readFile(result.runSummaryPath, "utf8")) as unknown,
    );
    const snapshot = SnapshotSchema.parse(
      JSON.parse(
        await readFile(
          join(generation.generationPath, "challenge/snapshot.json"),
          "utf8",
        ),
      ) as unknown,
    );

    expect(manifest.status).toBe("completed");
    expect(manifest.challengeVersion).toBe("1.1.0");
    expect(manifest.contestantIds).toEqual([
      "fixture-editorial",
      "fixture-geometric",
      "fixture-generic",
    ]);
    expect(manifest.judgeIds).toEqual(["fixture-critic-a", "fixture-critic-b"]);
    expect(runPlan.callCounts).toMatchObject({
      contestantCalls: 3,
      candidateJudgingCalls: 6,
      awardsCalls: 2,
      maximumTotalCalls: 11,
    });
    expect(runSummary.generationId).toBe("0001");
    expect(runSummary.contestants).toHaveLength(3);
    expect(runSummary.judges).toHaveLength(2);
    expect(runSummary.configuredMaximumCalls).toBe(11);
    expect(snapshot.inputHashes).toBeDefined();

    expect(
      leaderboard.entries.map((entry) => [
        entry.contestantId,
        entry.rank,
        entry.combinedScore,
      ]),
    ).toEqual([
      ["fixture-editorial", 1, 88.5],
      ["fixture-geometric", 2, 87],
      ["fixture-generic", 3, 58],
    ]);

    const challengeHtml = await readFile(
      join(generation.generationPath, "challenge/challenge.html"),
      "utf8",
    );
    const seedMatrix = matrixMarkup(challengeHtml);
    expect(seedMatrix).toContain('<th scope="col">Judge 1</th>');
    expect(seedMatrix).toContain('<th scope="col">Judge 2</th>');
    expect((seedMatrix.match(/<tr class="judge-matrix-row"/g) ?? []).length).toBe(3);
    expect((seedMatrix.match(/data-status="placeholder"/g) ?? []).length).toBe(6);
    expect((challengeHtml.match(/data-operational="runtime"/g) ?? []).length).toBe(3);
    expect(
      (challengeHtml.match(/data-operational="estimated-cost"/g) ?? []).length,
    ).toBe(3);
    expect((challengeHtml.match(/Runtime<\/dt><dd>—/g) ?? []).length).toBe(3);
    expect((challengeHtml.match(/Estimated cost<\/dt><dd>—/g) ?? []).length).toBe(3);

    const publicHtml = await readFile(
      join(result.gallery.publicPath, "index.html"),
      "utf8",
    );
    const publicMatrix = matrixMarkup(publicHtml);
    const publicRows = [
      ...publicMatrix.matchAll(
        /<tr class="judge-matrix-row"[^>]*data-contestant-id="([^"]+)"/g,
      ),
    ].map((match) => match[1]);
    expect(publicRows).toEqual(leaderboard.entries.map((entry) => entry.contestantId));
    expect((publicMatrix.match(/<th scope="col">/g) ?? []).length).toBe(5);
    expect(
      (publicMatrix.match(/<th scope="col">Fixture Critic [AB]<\/th>/g) ?? []).length,
    ).toBe(2);
    expect((publicMatrix.match(/data-status="score"/g) ?? []).length).toBe(6);
    expect((publicMatrix.match(/judge-matrix-combined/g) ?? []).length).toBe(3);
    expect((publicMatrix.match(/judge-matrix-range/g) ?? []).length).toBe(3);
    expect(publicHtml.indexOf('<table class="judge-matrix">')).toBeLessThan(
      publicHtml.indexOf('<article id="entry-detail-'),
    );
    for (const entry of leaderboard.entries) {
      expect(publicMatrix).toContain(
        `class="judge-matrix-cell judge-matrix-combined">${entry.combinedScore?.toFixed(2)}`,
      );
      expect(publicMatrix).toContain(
        `class="judge-matrix-cell judge-matrix-range">${entry.scoreRange?.toFixed(2)}`,
      );
      for (const score of entry.judgeScores) {
        expect(publicMatrix).toContain(`data-status="score">${score.totalScore}</td>`);
      }
    }

    for (const contestantId of manifest.contestantIds) {
      const run = RunSchema.parse(
        JSON.parse(
          await readFile(
            join(generation.generationPath, `contestants/${contestantId}/run.json`),
            "utf8",
          ),
        ) as unknown,
      );
      const expectedRuntime =
        run.durationMs === null ? "—" : `${(run.durationMs / 1000).toFixed(2)} s`;
      const expectedCost =
        run.usage.estimatedCostUsd === null
          ? "—"
          : `USD ${run.usage.estimatedCostUsd.toFixed(6)}`;
      expect(publicHtml).toContain(`Runtime</dt><dd>${expectedRuntime}`);
      expect(publicHtml).toContain(`Estimated cost</dt><dd>${expectedCost}`);
      await expectExactScreenshot(
        join(generation.generationPath, `contestants/${contestantId}/screenshot.png`),
      );
    }
    await expectExactScreenshot(result.gallery.screenshotPath);

    const champion = leaderboard.entries.find((entry) => entry.rank === 1);
    expect(champion).toBeDefined();
    if (champion === undefined) throw new Error("fixture leaderboard has no champion");
    expect(result.gallery.championContestantId).toBe(champion.contestantId);
    expect(result.gallery.stylesheetKind).toBe("champion");
    await expect(
      readFile(join(generation.generationPath, "public/champion.css")),
    ).resolves.toEqual(
      await readFile(
        join(
          generation.generationPath,
          `contestants/${champion.contestantId}/submission.css`,
        ),
      ),
    );

    const publicFiles = await filesUnder(result.gallery.publicPath);
    expect(publicFiles).not.toContain("run.json");
    expect(publicFiles).not.toContain("run-summary.json");
    expect(publicFiles.some((file) => file.includes("execution-metadata"))).toBe(false);
    const forbiddenPublicData =
      /fixture-request|providerRequestId|inputTokens|outputTokens|reasoningTokens|totalTokens|run-summary|execution-metadata|environmentAllowlist|promptPath|stdoutLog|stderrLog/iu;
    for (const file of publicFiles.filter((path) =>
      /\.(?:html|json|css)$/u.test(path),
    )) {
      expect(
        await readFile(join(result.gallery.publicPath, file), "utf8"),
        file,
      ).not.toMatch(forbiddenPublicData);
    }
    expect(publicHtml).not.toMatch(/<script\b/iu);
    expect(publicHtml).not.toMatch(/\b(?:src|href)=["'](?:https?:|\/\/)/iu);

    const sourceBefore = await hashSourceTree(generation.generationPath);
    await buildGallery({ repositoryRoot, generationPath: generation.generationPath });
    const sourceAfter = await hashSourceTree(generation.generationPath);
    expect([...sourceAfter.entries()]).toEqual([...sourceBefore.entries()]);
  }, 120000);
});
