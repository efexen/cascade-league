import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import sharp from "sharp";

import {
  buildSeedChallengePage,
  loadSeasonDefinition,
} from "../../src/challenge/index.js";
import {
  renderStaticPage,
  StaticPageNetworkError,
} from "../../src/rendering/static-page.js";
import { startLoopbackStaticServer } from "../../src/rendering/static-server.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

describe("static public page renderer", () => {
  it("captures a bounded full-height public page plus a fixed viewport view", async () => {
    const root = await createTestTempRoot("cascade-league-static-full-height-");
    const definition = await loadSeasonDefinition(
      join(repositoryRoot, "challenge/season-001"),
    );
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><html><body style="margin:0"><div style="height:2500px">Full page</div></body></html>',
    );
    const screenshotPath = join(root, "screenshot.png");
    const viewportScreenshotPath = join(root, "screenshot-viewport.png");

    const result = await renderStaticPage({
      rootPath: root,
      entryFile: "index.html",
      screenshotPath,
      viewportScreenshotPath,
      challengeConfig: definition.config,
    });

    expect(await sharp(screenshotPath).metadata()).toMatchObject({
      format: "png",
      width: 1280,
      height: 2500,
    });
    expect(await sharp(viewportScreenshotPath).metadata()).toMatchObject({
      format: "png",
      width: 1280,
      height: 1200,
    });
    expect(result.viewportScreenshotPath).toBe(viewportScreenshotPath);
  });

  it("wraps maximum-length unbroken judge labels in the fallback matrix", async () => {
    const root = await createTestTempRoot("local-maxima-fallback-wrap-");
    const definition = await loadSeasonDefinition(
      join(repositoryRoot, "challenge/season-001"),
    );
    const page = await buildSeedChallengePage({
      definition,
      generationId: "0001",
      rosterSize: 3,
      judgeCount: 2,
      stylesheetPath: "fallback.css",
      generatedAt: "2026-08-31T12:00:00.000Z",
    });
    const longLabel = `judge-${"x".repeat(194)}`;
    await writeFile(
      join(root, "index.html"),
      page.html
        .replace('<th scope="col">Judge 1</th>', `<th scope="col">${longLabel}</th>`)
        .replace('<th scope="col">Judge 2</th>', `<th scope="col">${longLabel}</th>`),
      "utf8",
    );
    await writeFile(join(root, "fallback.css"), definition.fallbackCss, "utf8");

    const rendered = await renderStaticPage({
      rootPath: root,
      entryFile: "index.html",
      screenshotPath: join(root, "screenshot.png"),
      challengeConfig: definition.config,
    });
    expect(rendered.externalRequests).toEqual([]);

    const browser = await chromium.launch();
    try {
      const browserPage = await browser.newPage({
        viewport: { width: 1280, height: 1200 },
        javaScriptEnabled: false,
      });
      await browserPage.goto(`file://${join(root, "index.html")}`, {
        waitUntil: "domcontentloaded",
      });
      const metrics = await browserPage.evaluate(() => {
        const matrix = document.querySelector(".judge-matrix");
        const header = document.querySelector(
          '.judge-matrix th[scope="col"]:nth-of-type(2)',
        );
        if (!(matrix instanceof HTMLElement) || !(header instanceof HTMLElement)) {
          throw new Error("fallback matrix header is missing");
        }
        const range = document.createRange();
        range.selectNodeContents(header);
        return {
          lineCount: range.getClientRects().length,
          matrixClientWidth: matrix.clientWidth,
          matrixScrollWidth: matrix.scrollWidth,
          headerClientWidth: header.clientWidth,
          headerScrollWidth: header.scrollWidth,
          overflowWrap: getComputedStyle(header).overflowWrap,
        };
      });
      expect(metrics.overflowWrap).toBe("anywhere");
      expect(metrics.lineCount).toBeGreaterThan(1);
      expect(metrics.matrixScrollWidth).toBeLessThanOrEqual(
        metrics.matrixClientWidth + 1,
      );
      expect(metrics.headerScrollWidth).toBeLessThanOrEqual(
        metrics.headerClientWidth + 1,
      );
    } finally {
      await browser.close();
    }
  }, 30000);

  it("disables script execution and aborts non-loopback requests", async () => {
    const root = await createTestTempRoot("local-maxima-static-page-");
    const definition = await loadSeasonDefinition(
      join(repositoryRoot, "challenge/season-001"),
    );
    await writeFile(
      join(root, "index.html"),
      `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><img src="https://example.invalid/image.png"><script>fetch("https://example.invalid/script.js");document.body.dataset.executed="yes";</script><p id="status">static</p></body></html>`,
    );
    await writeFile(join(root, "style.css"), "body { color: black; }\n");
    await expect(
      renderStaticPage({
        rootPath: root,
        entryFile: "index.html",
        screenshotPath: join(root, "screenshot.png"),
        challengeConfig: definition.config,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(StaticPageNetworkError);
      expect((error as StaticPageNetworkError).externalRequests).toContain(
        "https://example.invalid/image.png",
      );
      return true;
    });
  }, 30000);

  it("renders a local page with a script tag without executing it", async () => {
    const root = await createTestTempRoot("local-maxima-static-page-local-");
    const definition = await loadSeasonDefinition(
      join(repositoryRoot, "challenge/season-001"),
    );
    await writeFile(
      join(root, "index.html"),
      `<!doctype html><html><body><img src="seed.png"><script>document.body.dataset.executed="yes";</script><p>local-only</p></body></html>`,
    );
    await copyFile(
      join(repositoryRoot, "challenge/season-001/seed/thumbnails/seed-01.png"),
      join(root, "seed.png"),
    );
    const result = await renderStaticPage({
      rootPath: root,
      entryFile: "index.html",
      screenshotPath: join(root, "screenshot.png"),
      challengeConfig: definition.config,
    });
    expect(result.externalRequests).toEqual([]);
  }, 30000);

  it("rejects a symlinked server root before binding a port", async () => {
    const root = await createTestTempRoot("local-maxima-static-root-");
    const target = join(root, "target");
    const link = join(root, "link");
    await writeFile(target, "not a directory\n");
    await symlink(target, link);
    await expect(
      startLoopbackStaticServer({ rootPath: link, entryFile: "index.html" }),
    ).rejects.toThrow("real directory");
  });

  it("rejects traversal and symlinked files while serving only regular local files", async () => {
    const root = await createTestTempRoot("local-maxima-static-traversal-");
    const outside = await createTestTempRoot("local-maxima-static-outside-");
    await writeFile(join(root, "index.html"), "<!doctype html><p>local</p>");
    await writeFile(join(outside, "secret.txt"), "private\n");
    await mkdir(join(root, "nested"));
    await symlink(join(outside, "secret.txt"), join(root, "nested/secret.txt"));
    const server = await startLoopbackStaticServer({
      rootPath: root,
      entryFile: "index.html",
    });
    try {
      expect((await fetch(`${server.origin}/../secret.txt`)).status).toBe(404);
      expect((await fetch(`${server.origin}/nested/secret.txt`)).status).toBe(404);
      expect((await fetch(`${server.origin}/index.html`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
