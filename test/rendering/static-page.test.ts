import { copyFile, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadSeasonDefinition } from "../../src/challenge/index.js";
import {
  renderStaticPage,
  StaticPageNetworkError,
} from "../../src/rendering/static-page.js";
import { startLoopbackStaticServer } from "../../src/rendering/static-server.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

describe("static public page renderer", () => {
  it("disables script execution and aborts non-loopback requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-static-page-"));
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
    const root = await mkdtemp(join(tmpdir(), "local-maxima-static-page-local-"));
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
    const root = await mkdtemp(join(tmpdir(), "local-maxima-static-root-"));
    const target = join(root, "target");
    const link = join(root, "link");
    await writeFile(target, "not a directory\n");
    await symlink(target, link);
    await expect(
      startLoopbackStaticServer({ rootPath: link, entryFile: "index.html" }),
    ).rejects.toThrow("real directory");
  });

  it("rejects traversal and symlinked files while serving only regular local files", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-static-traversal-"));
    const outside = await mkdtemp(join(tmpdir(), "local-maxima-static-outside-"));
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
