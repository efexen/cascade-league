import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";

import {
  buildSeedChallengePage,
  loadSeasonDefinition,
} from "../../src/challenge/index.js";
import {
  GalleryContentVisibilityError,
  renderStaticPage,
  StaticPageNetworkError,
} from "../../src/rendering/static-page.js";
import { startLoopbackStaticServer } from "../../src/rendering/static-server.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

const MINIMAL_GALLERY_HTML = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>
<body><div class="page-shell">
<header id="masthead">Masthead</header><main id="main-content">
<section id="introduction">Introduction</section><section id="rules">Rules</section>
<section id="leaderboard"><ol class="leaderboard-grid"><li class="entry"><article class="entry-card">
<header class="entry-header"><p class="entry-rank">Rank 1</p><h3 class="entry-title">Contestant</h3><p class="entry-identity">Harness · Model</p></header>
<figure class="entry-visual"><div class="entry-thumbnail">Thumbnail</div><figcaption class="entry-caption">Valid</figcaption></figure>
<dl class="entry-scores"><div class="entry-runtime"><dt>Runtime</dt><dd>1.00 s</dd></div><div class="entry-estimated-cost"><dt>Estimated cost</dt><dd>USD 0.100000</dd></div></dl>
<ul class="entry-awards"><li class="entry-award">Award</li></ul><a class="entry-detail-link" href="#entry-detail-one">Notes</a>
</article></li></ol></section>
<section id="awards"><p class="empty-state">No awards</p></section><section id="method">Method</section>
<section id="judge-notes"><table class="judge-matrix"><caption>Matrix</caption><thead><tr><th scope="col">Contestant</th><th scope="col">Judge</th><th scope="col">Combined</th><th scope="col">Range</th></tr></thead><tbody><tr class="judge-matrix-row"><th scope="row">Contestant</th><td class="judge-matrix-cell" data-status="score">80</td><td class="judge-matrix-cell judge-matrix-combined">80.00</td><td class="judge-matrix-cell judge-matrix-range">0.00</td></tr></tbody></table>
<article id="entry-detail-one" class="entry-detail"><header class="entry-detail-header"><h3>Contestant</h3><p>Valid</p></header><p class="judge-critique">Readable critique.</p></article></section>
</main><footer id="site-footer">Footer</footer></div></body></html>`;

const MINIMAL_GALLERY_CSS = `
* { box-sizing: border-box; }
body { margin: 0; color: #111; font: 16px sans-serif; }
.page-shell { padding: 24px; }
#main-content { display: grid; gap: 24px; }
.entry-card { display: grid; gap: 8px; }
.entry-thumbnail { display: block; width: 160px; height: 100px; }
.entry-scores { display: grid; grid-template-columns: repeat(2, 1fr); }
.entry-scores dt, .entry-scores dd { margin: 0; }
.judge-matrix { border-collapse: collapse; }
.judge-matrix th, .judge-matrix td { border: 1px solid #111; padding: 8px; }
.entry-detail { min-height: 40px; }
`;

async function renderMinimalGallery(extraCss: string) {
  const root = await createTestTempRoot("local-maxima-static-gallery-");
  await writeFile(join(root, "index.html"), MINIMAL_GALLERY_HTML, "utf8");
  await writeFile(
    join(root, "style.css"),
    `${MINIMAL_GALLERY_CSS}\n${extraCss}`,
    "utf8",
  );
  const definition = await loadSeasonDefinition(
    join(repositoryRoot, "challenge/season-001"),
  );
  return renderStaticPage({
    rootPath: root,
    entryFile: "index.html",
    screenshotPath: join(root, "screenshot.png"),
    challengeConfig: { ...definition.config, requiredSelectors: [] },
    verifyGalleryContent: true,
  });
}

describe("static public page renderer", () => {
  it("rejects transparent public matrix and operational text", async () => {
    await expect(
      renderMinimalGallery(
        `.judge-matrix-cell[data-status="score"], .entry-runtime dd, .entry-estimated-cost dd { color: transparent !important; }`,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-matrix-cell|entry-runtime|entry-estimated-cost/i,
      );
      return true;
    });
  });

  it("rejects transparent text with an all-transparent text background", async () => {
    await expect(
      renderMinimalGallery(
        `.judge-matrix-cell[data-status="score"] { color: transparent !important; background-image: linear-gradient(transparent, transparent); background-clip: text; -webkit-background-clip: text; }`,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-matrix-cell|paint|transparent/i,
      );
      return true;
    });
  });

  it("accepts transparent fill when a non-transparent text shadow paints the text", async () => {
    const result = await renderMinimalGallery(
      `.judge-matrix-cell[data-status="score"] { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: 0 0 0 #111 !important; }`,
    );
    expect(result.externalRequests).toEqual([]);
    await expect(readFile(result.screenshotPath)).resolves.toBeTruthy();
  });

  it("rejects transparent fill when the painted text shadow is displaced outside clipped text", async () => {
    await expect(
      renderMinimalGallery(
        `.judge-matrix-cell[data-status="score"] { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: 100000px 0 #111 !important; overflow: hidden !important; }`,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-matrix-cell|shadow|paint|displacement/i,
      );
      return true;
    });
  });

  it("accepts transparent fill when a non-transparent text stroke paints the text", async () => {
    const result = await renderMinimalGallery(
      `.judge-matrix-cell[data-status="score"] { color: transparent !important; -webkit-text-fill-color: transparent !important; -webkit-text-stroke: 2px #111 !important; }`,
    );
    expect(result.externalRequests).toEqual([]);
    await expect(readFile(result.screenshotPath)).resolves.toBeTruthy();
  });

  it("rejects transparent modern computed color functions", async () => {
    await expect(
      renderMinimalGallery(
        `.judge-matrix-cell[data-status="score"] { color: oklch(0.5 0.1 30 / 0) !important; -webkit-text-fill-color: color(display-p3 0 0 0 / 0) !important; }`,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-matrix-cell|paint|transparent/i,
      );
      return true;
    });
  });

  it("rejects a large positive displacement of required public content", async () => {
    await expect(
      renderMinimalGallery(
        `.judge-matrix-cell[data-status="score"] { position: absolute; top: 100000px; }`,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-matrix-cell|displacement|position/i,
      );
      return true;
    });
  });

  it("rejects extreme positive padding displacement of required public text", async () => {
    await expect(
      renderMinimalGallery(
        `.judge-matrix-cell[data-status="score"] { padding-top: 100000px !important; }`,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-matrix-cell|padding|displacement/i,
      );
      return true;
    });
  });

  it("rejects a covering pseudo-element over required public text", async () => {
    await expect(
      renderMinimalGallery(`
        .judge-matrix-cell[data-status="score"] { position: relative; }
        .judge-matrix-cell[data-status="score"]::after {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 1;
          background: #111;
        }
      `),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-matrix-cell|pseudo|occlud|cover/i,
      );
      return true;
    });
  });

  it("rejects a covering pseudo-element painted only by an inset box shadow", async () => {
    await expect(
      renderMinimalGallery(`
        .judge-matrix-cell[data-status="score"] { position: relative; }
        .judge-matrix-cell[data-status="score"]::after {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 1;
          box-shadow: inset 0 0 0 9999px #111;
        }
      `),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-matrix-cell|pseudo|occlud|cover/i,
      );
      return true;
    });
  });

  it("allows a border-only pseudo-element that frames required public text", async () => {
    const result = await renderMinimalGallery(`
      .judge-matrix-cell[data-status="score"] { position: relative; }
      .judge-matrix-cell[data-status="score"]::after {
        content: "";
        position: absolute;
        inset: 0;
        z-index: 1;
        border: 2px solid #111;
        pointer-events: none;
      }
    `);
    expect(result.externalRequests).toEqual([]);
    await expect(readFile(result.screenshotPath)).resolves.toBeTruthy();
  });

  it("allows a thin inset shadow that only frames required public text", async () => {
    const result = await renderMinimalGallery(`
      .judge-matrix-cell[data-status="score"] { position: relative; }
      .judge-matrix-cell[data-status="score"]::after {
        content: "";
        position: absolute;
        inset: 0;
        z-index: 1;
        box-shadow: inset 0 0 0 2px #111;
        pointer-events: none;
      }
    `);
    expect(result.externalRequests).toEqual([]);
    await expect(readFile(result.screenshotPath)).resolves.toBeTruthy();
  });

  it("rejects required text displaced outside its own public cell", async () => {
    await expect(
      renderMinimalGallery(
        `.judge-matrix-cell[data-status="score"] { text-indent: 100000px; overflow: hidden; }`,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-matrix-cell|paint|displacement/i,
      );
      return true;
    });
  });

  it("allows benign thumbnail clipping and non-suppressive paint effects", async () => {
    const result = await renderMinimalGallery(
      `.entry-thumbnail { clip-path: circle(50%); filter: saturate(0.5); mask-image: linear-gradient(#000, #000); }`,
    );
    expect(result.externalRequests).toEqual([]);
    await expect(readFile(result.screenshotPath)).resolves.toBeTruthy();
  });

  it("allows visible clipped content with pointer events disabled", async () => {
    const result = await renderMinimalGallery(
      `.entry-thumbnail { clip-path: circle(50%); pointer-events: none; }`,
    );
    expect(result.externalRequests).toEqual([]);
    await expect(readFile(result.screenshotPath)).resolves.toBeTruthy();
  });

  it("allows broader benign clipping shapes on required text and visuals", async () => {
    const result = await renderMinimalGallery(`
      .entry-thumbnail { clip-path: ellipse(50% 50% at 50% 50%); }
      .entry-caption { clip-path: polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%); }
      .judge-critique { clip-path: inset(0 round 12px); }
    `);
    expect(result.externalRequests).toEqual([]);
    await expect(readFile(result.screenshotPath)).resolves.toBeTruthy();
  });

  it("allows a full-size mask aligned with percentage positions", async () => {
    const result = await renderMinimalGallery(`
      .entry-thumbnail {
        mask-image: linear-gradient(#111, #111);
        -webkit-mask-image: linear-gradient(#111, #111);
        mask-size: 100% 100%;
        -webkit-mask-size: 100% 100%;
        mask-position: 100% 100%;
        -webkit-mask-position: 100% 100%;
        mask-repeat: no-repeat;
        -webkit-mask-repeat: no-repeat;
      }
    `);
    expect(result.externalRequests).toEqual([]);
    await expect(readFile(result.screenshotPath)).resolves.toBeTruthy();
  });

  it("allows a partially painted mask with a named color stop", async () => {
    const result = await renderMinimalGallery(
      `.entry-thumbnail { mask-image: linear-gradient(black, transparent); }`,
    );
    expect(result.externalRequests).toEqual([]);
    await expect(readFile(result.screenshotPath)).resolves.toBeTruthy();
  });

  it("rejects a zero-area clip path on required public text", async () => {
    await expect(
      renderMinimalGallery(`.judge-critique { clip-path: inset(100%); }`),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-critique|clipped/i,
      );
      return true;
    });
  });

  it("rejects fully suppressive filters and masks on required public text", async () => {
    await expect(
      renderMinimalGallery(
        `.entry-runtime dd { filter: opacity(0); } .judge-matrix-cell[data-status="score"] { mask-image: linear-gradient(transparent, transparent); }`,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /entry-runtime|judge-matrix-cell|transparent|paint/i,
      );
      return true;
    });
  });

  it("rejects a zero-sized mask geometry on required public text", async () => {
    await expect(
      renderMinimalGallery(`
        .judge-critique {
          mask-image: linear-gradient(#111, #111);
          -webkit-mask-image: linear-gradient(#111, #111);
          mask-size: 0 0;
          -webkit-mask-size: 0 0;
          mask-repeat: no-repeat;
          -webkit-mask-repeat: no-repeat;
        }
      `),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-critique|mask|geometry|paint/i,
      );
      return true;
    });
  });

  it("rejects a non-repeating mask positioned entirely off required text", async () => {
    await expect(
      renderMinimalGallery(`
        .judge-critique {
          mask-image: linear-gradient(#111, #111);
          -webkit-mask-image: linear-gradient(#111, #111);
          mask-size: 4px 4px;
          -webkit-mask-size: 4px 4px;
          mask-position: 100000px 100000px;
          -webkit-mask-position: 100000px 100000px;
          mask-repeat: no-repeat;
          -webkit-mask-repeat: no-repeat;
        }
      `),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GalleryContentVisibilityError);
      expect((error as GalleryContentVisibilityError).failures.join(" ")).toMatch(
        /judge-critique|mask|geometry|paint/i,
      );
      return true;
    });
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
      verifyGalleryContent: true,
    });
    expect(rendered.externalRequests).toEqual([]);

    const browser = await chromium.launch();
    try {
      const browserPage = await browser.newPage({
        viewport: { width: 1440, height: 1200 },
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
