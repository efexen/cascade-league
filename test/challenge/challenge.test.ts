import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HtmlValidate } from "html-validate";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  buildSeedChallengePage,
  loadSeasonDefinition,
  SeedGenerationSchema,
} from "../../src/challenge/index.js";

const seasonRoot = new URL("../../challenge/season-001/", import.meta.url);

describe("Season 1 challenge", () => {
  it("passes offline semantic HTML validation", async () => {
    const definition = await loadSeasonDefinition(seasonRoot.pathname);
    const rendered = await buildSeedChallengePage({
      definition,
      generationId: "0001",
      rosterSize: 3,
      stylesheetPath: "submission.css",
      generatedAt: "2026-08-27T20:00:00.000Z",
    });
    const report = await new HtmlValidate({
      extends: ["html-validate:recommended"],
    }).validateString(rendered.html, "challenge.html");

    expect(report.results.flatMap((result) => result.messages)).toEqual([]);
  });

  it("renders the resolved challenge in Chromium standards mode", async () => {
    const definition = await loadSeasonDefinition(seasonRoot.pathname);
    const rendered = await buildSeedChallengePage({
      definition,
      generationId: "0001",
      rosterSize: 3,
      stylesheetPath: "submission.css",
      generatedAt: "2026-08-27T20:00:00.000Z",
    });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ javaScriptEnabled: false });
      await page.setContent(rendered.html, { waitUntil: "domcontentloaded" });
      expect(
        await page.evaluate(
          () =>
            (globalThis as unknown as { document: { compatMode: string } }).document
              .compatMode,
        ),
      ).toBe("CSS1Compat");
    } finally {
      await browser.close();
    }
  });

  it("renders the seed page with the frozen semantic hooks and configured roster size", async () => {
    const definition = await loadSeasonDefinition(seasonRoot.pathname);
    const page = await buildSeedChallengePage({
      definition,
      generationId: "0001",
      rosterSize: 3,
      stylesheetPath: "submission.css",
      generatedAt: "2026-08-27T20:00:00.000Z",
    });

    expect(page.html).toMatch(/<body\b[^>]*id="local-maxima"[^>]*class="season-page"/);
    expect(page.html).toContain('data-season="001"');
    expect(page.html).toContain('data-generation="0001"');
    for (const selector of [
      'id="masthead"',
      'id="introduction"',
      'id="rules"',
      'id="leaderboard"',
      'class="entry-card"',
      'id="awards"',
      'id="method"',
      'id="judge-notes"',
      'id="site-footer"',
    ]) {
      expect(page.html).toContain(selector);
    }
    expect((page.html.match(/class="entry-card"/g) ?? []).length).toBe(3);
    expect(page.html).toContain("Every contestant receives the same HTML.");
    expect(page.html).toContain("divergence, convergence, or judge gaming");
    expect(page.html).not.toMatch(/<script\b/i);
    expect(page.html).not.toMatch(/style\s*=/i);
  });

  it("uses checked-in seed data and local, licensed visual assets", async () => {
    const definition = await loadSeasonDefinition(seasonRoot.pathname);
    const page = await buildSeedChallengePage({
      definition,
      generationId: "0001",
      rosterSize: 6,
      stylesheetPath: "submission.css",
      generatedAt: "2026-08-27T20:00:00.000Z",
    });
    expect(page.entries).toHaveLength(6);
    expect(page.entries.every((entry) => entry.displayName === "Seed entry")).toBe(
      true,
    );
    expect(page.html).toContain('src="thumbnails/seed-01.png"');
    expect(page.html).not.toMatch(/https?:\/\//i);
    expect(page.html).toContain('href="submission.css"');

    const starter = await readFile(`${seasonRoot.pathname}/starter.css`, "utf8");
    expect(starter).toContain("@font-face");
    expect(starter).toContain("fonts/");
    expect(await readFile(`${seasonRoot.pathname}/fonts/README.md`, "utf8")).toMatch(
      /license/i,
    );
    for (const entry of page.entries) {
      const metadata = await sharp(
        join(
          seasonRoot.pathname,
          "seed",
          entry.screenshotPath.replace(/^thumbnails\//, "thumbnails/"),
        ),
      ).metadata();
      expect(metadata.width).toBe(1440);
      expect(metadata.height).toBe(1200);
      expect(metadata.format).toBe("png");
    }
  });

  it("rejects a roster size outside the two-to-six Season 1 contract", async () => {
    const definition = await loadSeasonDefinition(seasonRoot.pathname);
    await expect(
      buildSeedChallengePage({
        definition,
        generationId: "0001",
        rosterSize: 1,
        stylesheetPath: "submission.css",
        generatedAt: "2026-08-27T20:00:00.000Z",
      }),
    ).rejects.toThrow(/roster/i);
    await expect(
      buildSeedChallengePage({
        definition,
        generationId: "0001",
        rosterSize: 7,
        stylesheetPath: "submission.css",
        generatedAt: "2026-08-27T20:00:00.000Z",
      }),
    ).rejects.toThrow(/roster/i);
  });

  it("requires six distinct seed entries", async () => {
    const definition = await loadSeasonDefinition(seasonRoot.pathname);
    expect(() =>
      SeedGenerationSchema.parse({
        ...definition.seed,
        entries: definition.seed.entries.map((entry, index) =>
          index === 1 ? { ...entry, id: definition.seed.entries[0]!.id } : entry,
        ),
      }),
    ).toThrow();
  });
});
