import { copyFile, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
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

const NOT_RECORDED = "not-recorded";
const EFFECTIVE_OPACITY_EPSILON = 0.001;
const require = createRequire(import.meta.url);

export interface CandidateRenderInput {
  readonly candidateRootPath: string;
  readonly canonicalChallengeRootPath?: string;
  readonly submissionPath?: string;
  readonly screenshotPath: string;
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
      waitUntil: "domcontentloaded",
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
    await waitForRenderTick(page);

    for (const selector of input.challengeConfig.requiredSelectors) {
      let visible = false;
      try {
        visible = await page.locator(selector).first().isVisible();
      } catch {
        visible = false;
      }
      checks.push(
        check(
          `required_selector:${selector.replace(/[^a-zA-Z0-9]+/gu, "_")}`,
          visible ? "passed" : "failed",
          visible ? `${selector} is visible` : `${selector} is missing or not visible`,
          visible,
        ),
      );
      if (!visible) errors.push(`required selector is not visible: ${selector}`);
    }

    const layout = await page.evaluate(() => {
      const firstViewport = {
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        left: 0,
      };
      const entries = Array.from(document.querySelectorAll(".leaderboard-grid .entry"))
        .slice(0, 3)
        .map((element) => {
          const box = element.getBoundingClientRect();
          return (
            box.bottom > firstViewport.top &&
            box.top < firstViewport.bottom &&
            box.right > firstViewport.left &&
            box.left < firstViewport.right
          );
        });
      const bodyStyle = getComputedStyle(document.body);
      return {
        horizontalOverflow: Math.max(
          0,
          document.documentElement.scrollWidth - window.innerWidth,
        ),
        bodyOverflowX: bodyStyle.overflowX,
        bodyOverflowY: bodyStyle.overflowY,
        leadingEntriesVisible: entries,
      };
    });
    const overflowPassed = layout.horizontalOverflow <= 2;
    checks.push(
      check(
        "horizontal_overflow",
        overflowPassed ? "passed" : "failed",
        overflowPassed
          ? "No horizontal overflow beyond two CSS pixels"
          : "Horizontal overflow exceeds two CSS pixels",
        layout.horizontalOverflow,
      ),
    );
    if (!overflowPassed) errors.push("horizontal overflow exceeds two CSS pixels");
    checks.push(
      check(
        "body_overflow",
        "passed",
        `Body overflow rules observed: x=${layout.bodyOverflowX}, y=${layout.bodyOverflowY}`,
      ),
    );
    if (layout.leadingEntriesVisible.length >= 3) {
      const leadingPassed = layout.leadingEntriesVisible.every(Boolean);
      checks.push(
        check(
          "leading_entries_viewport",
          leadingPassed ? "passed" : "failed",
          leadingPassed
            ? "The first three leaderboard entries intersect the first viewport"
            : "A leading leaderboard entry is below or outside the first viewport",
        ),
      );
      if (!leadingPassed)
        errors.push(
          "the first three leaderboard entries do not intersect the first viewport",
        );
    } else {
      checks.push(
        check(
          "leading_entries_viewport",
          "warning",
          "Fewer than three leaderboard entries were present",
        ),
      );
      warnings.push("fewer than three leaderboard entries were present");
    }

    const hiddenRequired = await page.evaluate(
      ({ selectors, opacityEpsilon }) => {
        const failures: string[] = [];

        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element === null) {
            failures.push(`${selector} (missing)`);
            continue;
          }

          let effectiveOpacity = 1;
          const hidingElements: string[] = [];
          const opacityElements: string[] = [];
          for (
            let ancestor: Element | null = element;
            ancestor !== null;
            ancestor = ancestor.parentElement
          ) {
            const style = getComputedStyle(ancestor);
            const firstClass = (ancestor.getAttribute("class") ?? "")
              .trim()
              .split(/\s+/u)[0];
            const descriptor =
              ancestor.id !== ""
                ? `#${ancestor.id}`
                : firstClass === undefined || firstClass === ""
                  ? ancestor.tagName.toLowerCase()
                  : `${ancestor.tagName.toLowerCase()}.${firstClass}`;
            if (style.display === "none") {
              hidingElements.push(`${descriptor} display:none`);
            }
            if (style.visibility === "hidden" || style.visibility === "collapse") {
              hidingElements.push(`${descriptor} visibility:${style.visibility}`);
            }

            const opacity = Number.parseFloat(style.opacity);
            if (Number.isFinite(opacity)) {
              effectiveOpacity *= opacity;
              if (opacity <= opacityEpsilon) {
                opacityElements.push(`${descriptor} opacity:${style.opacity}`);
              }
            }
          }

          const reasons: string[] = [...hidingElements];
          if (effectiveOpacity <= opacityEpsilon) {
            const opacityDetail =
              opacityElements.length === 0
                ? `effective opacity:${effectiveOpacity}`
                : `effective opacity:${effectiveOpacity} via ${opacityElements.join(
                    " -> ",
                  )}`;
            reasons.push(opacityDetail);
          }
          if (reasons.length > 0) {
            failures.push(`${selector} (${reasons.join("; ")})`);
          }
        }
        return failures;
      },
      {
        selectors: input.challengeConfig.requiredSelectors,
        opacityEpsilon: EFFECTIVE_OPACITY_EPSILON,
      },
    );
    const hiddenPassed = hiddenRequired.length === 0;
    checks.push(
      check(
        "required_content_visibility",
        hiddenPassed ? "passed" : "failed",
        hiddenPassed
          ? "Required content is not hidden or transparent"
          : `Hidden or transparent required selectors: ${hiddenRequired.join(", ")}`,
      ),
    );
    if (!hiddenPassed) {
      errors.push(
        `required content is hidden or transparent: ${hiddenRequired.join(", ")}`,
      );
    }
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
      await mkdir(dirname(input.screenshotPath), { recursive: true });
      screenshotAttempted = true;
      screenshotTemporaryPath = `${input.screenshotPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
      if (options.screenshot === undefined) {
        await page.screenshot({
          path: screenshotTemporaryPath,
          fullPage: false,
          type: "png",
        });
      } else {
        await options.screenshot(page, screenshotTemporaryPath);
      }
      const image = await sharp(screenshotTemporaryPath).metadata();
      const screenshotPassed =
        image.width === 1440 && image.height === 1200 && image.format === "png";
      checks.push(
        check(
          "screenshot_dimensions",
          screenshotPassed ? "passed" : "failed",
          screenshotPassed
            ? "Screenshot is an exact 1440×1200 PNG"
            : "Screenshot dimensions or format are incorrect",
          `${String(image.width)}x${String(image.height)}`,
        ),
      );
      if (!screenshotPassed) {
        errors.push("screenshot is not an exact 1440×1200 PNG");
        await rm(screenshotTemporaryPath, { force: true });
        screenshotTemporaryPath = null;
      } else {
        await rename(screenshotTemporaryPath, input.screenshotPath);
        screenshotTemporaryPath = null;
      }
    } else {
      checks.push(
        check(
          "screenshot_dimensions",
          "not_run",
          "Screenshot was not captured because render checks failed",
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
