import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import sharp from "sharp";

import type { ChallengeConfig } from "../schemas/index.js";
import {
  startLoopbackStaticServer,
  type LoopbackStaticServer,
} from "./static-server.js";
import { publishFilePairAtomically } from "./atomic-pair.js";

const NOT_RECORDED = "not-recorded";
const FULL_HEIGHT_CAP = 12000;
const require = createRequire(import.meta.url);

export interface CandidateRenderInput {
  readonly candidateRootPath: string;
  readonly canonicalChallengeRootPath?: string;
  readonly submissionPath?: string;
  readonly screenshotPath: string;
  readonly viewportScreenshotPath?: string;
  readonly challengeConfig: ChallengeConfig;
}

export interface RenderCheck {
  readonly code: string;
  readonly status: "passed" | "warning" | "failed" | "not_run";
  readonly value?: string | number | boolean | null;
  readonly message: string;
}

export interface CandidateRenderResult {
  readonly status: "valid" | "render_failed";
  readonly screenshotPath: string | null;
  readonly viewportScreenshotPath?: string | null;
  readonly renderChecks: readonly RenderCheck[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly externalRequests: readonly string[];
  readonly observedVersions: {
    readonly playwright: string;
    readonly chromium: string;
  };
}

export interface CandidateRendererOptions {
  readonly launchBrowser?: () => Promise<Browser>;
  readonly startServer?: typeof startLoopbackStaticServer;
  readonly screenshot?: (page: Page, path: string) => Promise<void>;
  readonly moveFile?: typeof rename;
}

interface RenderWorkspace {
  readonly path: string;
  cleanup(): Promise<void>;
}

function check(
  code: string,
  status: RenderCheck["status"],
  message: string,
  value?: RenderCheck["value"],
): RenderCheck {
  return value === undefined
    ? { code, status, message }
    : { code, status, value, message };
}

function playwrightVersion(): string {
  try {
    const packagePath = require.resolve("playwright/package.json");
    const contents = readFileSync(packagePath, "utf8") as string;
    const parsed = JSON.parse(contents) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : NOT_RECORDED;
  } catch {
    return NOT_RECORDED;
  }
}

async function copySafeDirectory(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const sourceStatus = await lstat(sourcePath);
  if (sourceStatus.isSymbolicLink() || !sourceStatus.isDirectory()) {
    throw new Error("candidate challenge asset directory must be a real directory");
  }
  await mkdir(destinationPath, { recursive: true });
  for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
    const source = join(sourcePath, entry.name);
    const destination = join(destinationPath, entry.name);
    if (entry.isDirectory()) {
      await copySafeDirectory(source, destination);
    } else if (entry.isFile()) {
      const status = await lstat(source);
      if (status.isSymbolicLink())
        throw new Error("candidate challenge asset must not be a symlink");
      await copyFile(source, destination);
    }
  }
}

async function makeRenderWorkspace(
  input: CandidateRenderInput,
): Promise<RenderWorkspace> {
  const challengeRootPath = input.canonicalChallengeRootPath ?? input.candidateRootPath;
  const candidateRootStatus = await lstat(challengeRootPath);
  if (candidateRootStatus.isSymbolicLink() || !candidateRootStatus.isDirectory()) {
    throw new Error("candidate challenge directory must be a real directory");
  }
  const challengePath = join(challengeRootPath, "challenge.html");
  const challengeStatus = await lstat(challengePath);
  if (challengeStatus.isSymbolicLink() || !challengeStatus.isFile()) {
    throw new Error("candidate challenge entry must be a regular file");
  }
  const workspacePath = await (async () => {
    const { mkdtemp } = await import("node:fs/promises");
    return mkdtemp(join(dirname(resolve(challengeRootPath)), ".render-"));
  })();
  try {
    await copyFile(challengePath, join(workspacePath, "challenge.html"));
    const submissionPath =
      input.submissionPath ?? join(input.candidateRootPath, "submission.css");
    const submissionStatus = await lstat(submissionPath);
    if (submissionStatus.isSymbolicLink() || !submissionStatus.isFile()) {
      throw new Error("candidate submission must be a regular file");
    }
    await copyFile(submissionPath, join(workspacePath, "submission.css"));
    for (const assetDirectory of ["fonts", "thumbnails", "assets"]) {
      const source = join(challengeRootPath, assetDirectory);
      try {
        await copySafeDirectory(source, join(workspacePath, assetDirectory));
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") throw error;
      }
    }
    return {
      path: workspacePath,
      cleanup: () => rm(workspacePath, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

function isLoopbackRequest(urlValue: string, server: LoopbackStaticServer): boolean {
  try {
    const url = new URL(urlValue);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "[::1]") &&
      Number.parseInt(url.port || "80", 10) === server.port
    );
  } catch {
    return false;
  }
}

async function waitForRenderTick(page: Page): Promise<void> {
  // Page JavaScript is disabled, so a browser-side rAF/timer never runs.
  // A driver-side 16 ms pause still gives Chromium one deterministic frame.
  await page.waitForTimeout(16);
}

async function closeQuietly(
  resource: { close(): Promise<void> } | null,
): Promise<void> {
  if (resource !== null) await resource.close().catch(() => undefined);
}

export async function renderCandidate(
  input: CandidateRenderInput,
  options: CandidateRendererOptions = {},
): Promise<CandidateRenderResult> {
  const checks: RenderCheck[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const externalRequests: string[] = [];
  let workspace: RenderWorkspace | null = null;
  let server: LoopbackStaticServer | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let screenshotTemporaryPath: string | null = null;
  let screenshotAttempted = false;
  let screenshotWasPresent = false;
  let resolvedViewportPath: string | null = null;
  let chromiumVersion = NOT_RECORDED;
  const observedVersions = { playwright: playwrightVersion(), chromium: NOT_RECORDED };
  try {
    try {
      await lstat(input.screenshotPath);
      screenshotWasPresent = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    workspace = await makeRenderWorkspace(input);
    server = await (options.startServer ?? startLoopbackStaticServer)({
      rootPath: workspace.path,
      entryFile: "challenge.html",
    });
    browser = await (
      options.launchBrowser ?? (() => chromium.launch({ headless: true }))
    )();
    chromiumVersion = browser.version();
    observedVersions.chromium = chromiumVersion;
    context = await browser.newContext({
      viewport: {
        width: input.challengeConfig.viewport.width,
        height: input.challengeConfig.viewport.height,
      },
      deviceScaleFactor: input.challengeConfig.viewport.deviceScaleFactor,
      colorScheme: input.challengeConfig.browser.colorScheme,
      reducedMotion: input.challengeConfig.browser.reducedMotion,
      locale: input.challengeConfig.browser.locale,
      timezoneId: input.challengeConfig.browser.timezoneId,
      javaScriptEnabled: input.challengeConfig.browser.javaScriptEnabled,
    });
    await context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (!isLoopbackRequest(requestUrl, server!)) {
        externalRequests.push(requestUrl);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    page = await context.newPage();
    await page.goto(`${server.origin}/challenge.html`, {
      waitUntil: "load",
    });
    checks.push(check("document_loaded", "passed", "Challenge document loaded"));
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const fontStatus = await page.evaluate(() => document.fonts.status);
    checks.push(
      check(
        "local_fonts",
        fontStatus === "loaded" ? "passed" : "failed",
        fontStatus === "loaded"
          ? "Local fonts finished loading"
          : `Font loading status: ${fontStatus}`,
        fontStatus,
      ),
    );
    if (fontStatus !== "loaded") errors.push("challenge fonts did not finish loading");
    await waitForRenderTick(page);

    const externalPassed = externalRequests.length === 0;
    checks.push(
      check(
        "external_requests",
        externalPassed ? "passed" : "failed",
        externalPassed
          ? "No non-loopback requests were attempted"
          : `${externalRequests.length} non-loopback request(s) were aborted`,
        externalRequests.length,
      ),
    );
    if (!externalPassed) errors.push("non-loopback network requests were attempted");

    if (errors.length === 0) {
      const viewportPath =
        input.viewportScreenshotPath ??
        join(dirname(input.screenshotPath), "screenshot-viewport.png");
      const documentHeight = await page.evaluate(() => {
        const candidates = [
          document.documentElement?.scrollHeight,
          document.body?.scrollHeight,
          document.documentElement?.offsetHeight,
          document.body?.offsetHeight,
          document.documentElement?.clientHeight,
        ];
        const finite = candidates.filter(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value) && value > 0,
        );
        return finite.length === 0 ? window.innerHeight : Math.max(...finite);
      });
      const safeHeight = Number.isFinite(documentHeight)
        ? Math.max(1, Math.floor(documentHeight))
        : input.challengeConfig.viewport.height;
      const capturedHeight = Math.min(safeHeight, FULL_HEIGHT_CAP);
      if (safeHeight > FULL_HEIGHT_CAP) {
        warnings.push(
          `document height ${safeHeight}px exceeds cap ${FULL_HEIGHT_CAP}px; captured top ${FULL_HEIGHT_CAP}px`,
        );
      }
      await mkdir(dirname(input.screenshotPath), { recursive: true });
      await mkdir(dirname(viewportPath), { recursive: true });
      screenshotAttempted = true;
      screenshotTemporaryPath = `${input.screenshotPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
      const viewportTemporaryPath = `${viewportPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
      try {
        if (options.screenshot === undefined) {
          const cdp = await context.newCDPSession(page);
          try {
            const capture = await cdp.send("Page.captureScreenshot", {
              format: "png",
              fromSurface: true,
              captureBeyondViewport: true,
              clip: {
                x: 0,
                y: 0,
                width: input.challengeConfig.viewport.width,
                height: capturedHeight,
                scale: 1,
              },
            });
            await writeFile(
              screenshotTemporaryPath,
              Buffer.from(capture.data, "base64"),
            );
          } finally {
            await cdp.detach().catch(() => undefined);
          }
        } else {
          await options.screenshot(page, screenshotTemporaryPath);
        }
        const image = await sharp(screenshotTemporaryPath).metadata();
        const expectedWidth = input.challengeConfig.viewport.width;
        const screenshotPassed =
          image.width === expectedWidth &&
          image.height === capturedHeight &&
          image.format === "png";
        checks.push(
          check(
            "screenshot_dimensions",
            screenshotPassed ? "passed" : "failed",
            screenshotPassed
              ? `Screenshot is a bounded ${String(expectedWidth)}×${String(capturedHeight)} PNG`
              : "Screenshot dimensions or format are incorrect",
            `${String(image.width)}x${String(image.height)}`,
          ),
        );
        await page.screenshot({
          path: viewportTemporaryPath,
          fullPage: false,
          type: "png",
        });
        const viewportImage = await sharp(viewportTemporaryPath).metadata();
        const viewportPassed =
          viewportImage.width === expectedWidth &&
          viewportImage.height === input.challengeConfig.viewport.height &&
          viewportImage.format === "png";
        checks.push(
          check(
            "viewport_screenshot_dimensions",
            viewportPassed ? "passed" : "failed",
            viewportPassed
              ? `Viewport preview is an exact ${String(expectedWidth)}×${String(input.challengeConfig.viewport.height)} PNG`
              : "Viewport screenshot was not captured at the configured dimensions",
            `${String(viewportImage.width)}x${String(viewportImage.height)}`,
          ),
        );
        if (!screenshotPassed) {
          errors.push(
            `screenshot is not an exact ${String(expectedWidth)}×${String(capturedHeight)} PNG`,
          );
        }
        if (!viewportPassed) {
          errors.push(
            `viewport screenshot is not an exact ${String(expectedWidth)}×${String(input.challengeConfig.viewport.height)} PNG`,
          );
        }
        if (screenshotPassed && viewportPassed) {
          await publishFilePairAtomically(
            {
              firstTemporaryPath: screenshotTemporaryPath,
              firstDestinationPath: input.screenshotPath,
              secondTemporaryPath: viewportTemporaryPath,
              secondDestinationPath: viewportPath,
            },
            options.moveFile === undefined ? {} : { moveFile: options.moveFile },
          );
          screenshotTemporaryPath = null;
          resolvedViewportPath = viewportPath;
        }
      } finally {
        await rm(viewportTemporaryPath, { force: true }).catch(() => undefined);
      }
    } else {
      checks.push(
        check(
          "screenshot_dimensions",
          "not_run",
          "Screenshot was not captured because a render prerequisite failed",
        ),
      );
      checks.push(
        check(
          "viewport_screenshot_dimensions",
          "not_run",
          "Screenshot was not captured because a render prerequisite failed",
        ),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    checks.push(check("render_execution", "failed", message));
  } finally {
    if (screenshotTemporaryPath !== null) {
      await rm(screenshotTemporaryPath, { force: true });
    }
    if (screenshotAttempted && errors.length > 0 && !screenshotWasPresent) {
      await rm(input.screenshotPath, { force: true });
    }
    await closeQuietly(page === null ? null : { close: () => page!.close() });
    await closeQuietly(context === null ? null : { close: () => context!.close() });
    await closeQuietly(browser === null ? null : { close: () => browser!.close() });
    await closeQuietly(server);
    if (workspace !== null) await workspace.cleanup();
  }
  return {
    status: errors.length === 0 ? "valid" : "render_failed",
    screenshotPath: errors.length === 0 ? input.screenshotPath : null,
    viewportScreenshotPath: errors.length === 0 ? resolvedViewportPath : null,
    renderChecks: checks,
    errors,
    warnings,
    externalRequests,
    observedVersions,
  };
}

export class PlaywrightCandidateRenderer {
  private readonly options: CandidateRendererOptions;

  public constructor(options: CandidateRendererOptions = {}) {
    this.options = options;
  }

  public render(input: CandidateRenderInput): Promise<CandidateRenderResult> {
    return renderCandidate(input, this.options);
  }
}
