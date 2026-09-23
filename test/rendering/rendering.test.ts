import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { ChallengeConfigSchema } from "../../src/schemas/index.js";
import {
  renderCandidate,
  startLoopbackStaticServer,
} from "../../src/rendering/index.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const config = ChallengeConfigSchema.parse({
  schemaVersion: 1,
  seasonId: "0001",
  title: "Cascade League",
  challengeVersion: "1.0.0",
  template: "challenge.hbs",
  starterCss: "starter.css",
  fallbackCss: "fallback.css",
  seedData: "seed/seed-generation.json",
  viewport: { width: 1280, height: 1200, deviceScaleFactor: 1 },
  browser: {
    engine: "chromium",
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-GB",
    timezoneId: "UTC",
    javaScriptEnabled: false,
  },
  submission: {
    filename: "submission.css",
    maximumBytes: 61440,
    allowImports: false,
    allowRemoteUrls: false,
    allowDataUrls: false,
  },
  requiredSelectors: [
    "#masthead",
    "#introduction",
    "#rules",
    "#leaderboard",
    ".entry-card",
    "#judge-notes",
  ],
});

const html = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><link rel="stylesheet" href="submission.css"></head>
<body><header id="masthead">Masthead</header><main>
<section id="introduction">Intro</section><section id="rules">Rules</section>
<section id="leaderboard"><ol class="leaderboard-grid">
<li class="entry"><article class="entry-card">One</article></li>
<li class="entry"><article class="entry-card">Two</article></li>
<li class="entry"><article class="entry-card">Three</article></li>
</ol></section><section id="judge-notes">Notes</section></main></body></html>`;

describe("deterministic candidate rendering", () => {
  it("captures and keeps a visually hidden design for judging", async () => {
    const root = await createTestTempRoot("local-maxima-render-hidden-design-");
    await writeFile(join(root, "challenge.html"), html, "utf8");
    await writeFile(
      join(root, "submission.css"),
      "body { opacity: 0; min-height: 4000px; }",
      "utf8",
    );
    const screenshotPath = join(root, "screenshot.png");

    const result = await renderCandidate({
      candidateRootPath: root,
      screenshotPath,
      challengeConfig: config,
    });

    expect(result.status).toBe("valid");
    expect(result.screenshotPath).toBe(screenshotPath);
    expect(await sharp(screenshotPath).metadata()).toMatchObject({
      format: "png",
      width: config.viewport.width,
    });
    expect((await sharp(screenshotPath).metadata()).height).toBeGreaterThan(
      config.viewport.height,
    );
    expect(await sharp(join(root, "screenshot-viewport.png")).metadata()).toMatchObject(
      {
        format: "png",
        width: config.viewport.width,
        height: config.viewport.height,
      },
    );
  });

  it("captures a full-height judge image and fixed viewport preview", async () => {
    const root = await createTestTempRoot("local-maxima-render-");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "challenge.html"), html, "utf8");
    await writeFile(
      join(root, "submission.css"),
      "body { margin: 0; min-height: 2500px; font-family: sans-serif; } .leaderboard-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; } .entry-card { min-height: 180px; border: 1px solid black; }",
      "utf8",
    );
    const screenshotPath = join(root, "screenshot.png");
    const viewportScreenshotPath = join(root, "screenshot-viewport.png");

    const result = await renderCandidate({
      candidateRootPath: root,
      screenshotPath,
      viewportScreenshotPath,
      challengeConfig: config,
    });

    expect(
      result.status,
      `${result.errors.join(" | ")} ${JSON.stringify(result.renderChecks)}`,
    ).toBe("valid");
    expect(result.externalRequests).toEqual([]);
    expect(result.observedVersions.playwright).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(await readFile(screenshotPath)).toHaveLength(
      (await readFile(screenshotPath)).byteLength,
    );
    const image = await sharp(screenshotPath).metadata();
    expect(image.format).toBe("png");
    expect(image.width).toBe(1280);
    expect(image.height).toBe(2500);
    const viewportImage = await sharp(viewportScreenshotPath).metadata();
    expect(viewportImage.format).toBe("png");
    expect(viewportImage.width).toBe(1280);
    expect(viewportImage.height).toBe(1200);
    expect(viewportImage).toMatchObject({ width: image.width, height: 1200 });
    expect(result.viewportScreenshotPath).toBe(viewportScreenshotPath);
  });

  it("caps full-height judging while keeping hidden and overflowing CSS valid", async () => {
    const root = await createTestTempRoot("local-maxima-render-creative-css-");
    await writeFile(join(root, "challenge.html"), html, "utf8");
    await writeFile(
      join(root, "submission.css"),
      "body { width: 3000px; min-height: 16000px; } #rules { display:none; } #leaderboard { clip-path: inset(100%); } .entry-card { mask-image: linear-gradient(transparent, transparent); }",
      "utf8",
    );
    const screenshotPath = join(root, "screenshot.png");
    const result = await renderCandidate({
      candidateRootPath: root,
      screenshotPath,
      challengeConfig: config,
    });

    expect(result.status).toBe("valid");
    expect(result.warnings.join(" ")).toContain("12000px");
    expect(await sharp(screenshotPath).metadata()).toMatchObject({
      format: "png",
      width: config.viewport.width,
      height: 12000,
    });
    expect(await sharp(join(root, "screenshot-viewport.png")).metadata()).toMatchObject(
      {
        format: "png",
        width: config.viewport.width,
        height: config.viewport.height,
      },
    );
  });

  it("records and aborts an external browser request", async () => {
    const root = await createTestTempRoot("local-maxima-render-network-");
    await writeFile(
      join(root, "challenge.html"),
      html.replace(
        "<body>",
        '<body><img src="https://outside.example/track.png" alt="">',
      ),
      "utf8",
    );
    await writeFile(join(root, "submission.css"), "body { margin: 0; }", "utf8");

    const result = await renderCandidate({
      candidateRootPath: root,
      screenshotPath: join(root, "screenshot.png"),
      challengeConfig: config,
    });

    expect(result.status).toBe("render_failed");
    expect(result.externalRequests).toContain("https://outside.example/track.png");
    expect(
      result.renderChecks.find((entry) => entry.code === "external_requests")?.status,
    ).toBe("failed");
  });

  it("serves only regular files inside the candidate challenge directory", async () => {
    const root = await createTestTempRoot("local-maxima-static-server-");
    const outside = await createTestTempRoot("local-maxima-static-outside-");
    await writeFile(join(root, "challenge.html"), "inside", "utf8");
    await writeFile(join(outside, "secret.txt"), "outside", "utf8");
    await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
    const server = await startLoopbackStaticServer({ rootPath: root });
    try {
      expect(await (await fetch(`${server.origin}/challenge.html`)).text()).toBe(
        "inside",
      );
      expect((await fetch(`${server.origin}/%2e%2e/secret.txt`)).status).toBe(404);
      expect((await fetch(`${server.origin}/leak.txt`)).status).toBe(404);
      expect((await fetch(`${server.origin}/missing.txt`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("does not follow a symlinked challenge entry file", async () => {
    const root = await createTestTempRoot("local-maxima-render-symlink-");
    const outside = await createTestTempRoot("local-maxima-render-symlink-outside-");
    await writeFile(join(outside, "challenge.html"), html, "utf8");
    await symlink(join(outside, "challenge.html"), join(root, "challenge.html"));
    await writeFile(join(root, "submission.css"), "body { margin: 0; }", "utf8");

    const result = await renderCandidate({
      candidateRootPath: root,
      screenshotPath: join(root, "screenshot.png"),
      challengeConfig: config,
    });

    expect(result.status).toBe("render_failed");
    expect(result.errors.join(" ")).toMatch(/regular|symlink/i);
  });

  it("cleans a partial screenshot when screenshot creation fails", async () => {
    const root = await createTestTempRoot("local-maxima-render-screenshot-failure-");
    await writeFile(join(root, "challenge.html"), html, "utf8");
    await writeFile(join(root, "submission.css"), "body { margin: 0; }", "utf8");
    const screenshotPath = join(root, "screenshot.png");

    const result = await renderCandidate(
      {
        candidateRootPath: root,
        screenshotPath,
        challengeConfig: config,
      },
      {
        screenshot: async (_page, temporaryPath) => {
          await writeFile(temporaryPath, "partial", "utf8");
          throw new Error("injected screenshot failure");
        },
      },
    );

    expect(result.status).toBe("render_failed");
    expect(result.screenshotPath).toBeNull();
    await expect(readFile(screenshotPath)).rejects.toThrow();
    await expect(readFile(`${screenshotPath}.tmp`)).rejects.toThrow();
  });

  it("preserves an existing screenshot when a replacement capture fails", async () => {
    const root = await createTestTempRoot("local-maxima-render-screenshot-preserve-");
    await writeFile(join(root, "challenge.html"), html, "utf8");
    await writeFile(join(root, "submission.css"), "body { margin: 0; }", "utf8");
    const screenshotPath = join(root, "screenshot.png");
    await writeFile(screenshotPath, "previous screenshot", "utf8");

    const result = await renderCandidate(
      {
        candidateRootPath: root,
        screenshotPath,
        challengeConfig: config,
      },
      {
        screenshot: async (_page, temporaryPath) => {
          await writeFile(temporaryPath, "partial", "utf8");
          throw new Error("injected replacement failure");
        },
      },
    );

    expect(result.status).toBe("render_failed");
    expect(await readFile(screenshotPath, "utf8")).toBe("previous screenshot");
  });
});
