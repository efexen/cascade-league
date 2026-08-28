import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import sharp from "sharp";

import type { ChallengeConfig } from "../schemas/index.js";
import {
  startLoopbackStaticServer,
  type LoopbackStaticServer,
} from "./static-server.js";

const NOT_RECORDED = "not-recorded";

export interface StaticPageRenderInput {
  readonly rootPath: string;
  readonly entryFile: string;
  readonly screenshotPath: string;
  readonly challengeConfig: ChallengeConfig;
  readonly verifyGalleryContent?: boolean;
}

export interface StaticPageRenderOptions {
  readonly launchBrowser?: () => Promise<Browser>;
  readonly startServer?: typeof startLoopbackStaticServer;
  readonly screenshot?: (page: Page, path: string) => Promise<void>;
}

export interface StaticPageRenderResult {
  readonly screenshotPath: string;
  readonly externalRequests: readonly string[];
  readonly observedVersions: {
    readonly playwright: string;
    readonly chromium: string;
  };
}

export class StaticPageNetworkError extends Error {
  public readonly externalRequests: readonly string[];

  public constructor(externalRequests: readonly string[]) {
    super(
      `static page attempted ${String(externalRequests.length)} non-loopback request(s)`,
    );
    this.name = "StaticPageNetworkError";
    this.externalRequests = [...externalRequests];
  }
}

export class GalleryContentVisibilityError extends Error {
  public readonly failures: readonly string[];

  public constructor(failures: readonly string[]) {
    super(`gallery content is not effectively visible: ${failures.join(", ")}`);
    this.name = "GalleryContentVisibilityError";
    this.failures = [...failures];
  }
}

const GALLERY_CONTENT_SELECTORS = [
  ".entry",
  ".entry-card",
  ".entry-header",
  ".entry-rank",
  ".entry-title",
  ".entry-identity",
  ".entry-visual",
  ".entry-thumbnail",
  ".entry-caption",
  ".entry-scores",
  ".entry-scores > div",
  ".entry-scores dt",
  ".entry-scores dd",
  ".entry-failure",
  ".entry-award",
  ".entry-detail-link",
  ".entry-detail",
  ".entry-detail-header",
  ".judge-note-list",
  ".judge-note",
  ".judge-score",
  ".judge-dimension-scores",
  ".judge-dimension-scores > div",
  ".judge-dimension-scores dt",
  ".judge-dimension-scores dd",
  ".judge-critique",
  ".award",
  ".award-label",
  ".award-winner",
  ".award-rationale",
  ".empty-state",
] as const;

const GALLERY_REQUIRED_SELECTORS = [
  "#masthead",
  "#main-content",
  "#introduction",
  "#rules",
  "#leaderboard",
  ".entry-card",
  "#awards",
  "#method",
  "#judge-notes",
  "#site-footer",
] as const;

async function assertGalleryContentVisibility(
  page: Page,
  challengeConfig: ChallengeConfig,
): Promise<void> {
  const selectors = [
    ...GALLERY_REQUIRED_SELECTORS,
    ...challengeConfig.requiredSelectors,
    ...GALLERY_CONTENT_SELECTORS,
  ].filter((selector, index, all) => all.indexOf(selector) === index);
  const requiredSelectors = [
    ...GALLERY_REQUIRED_SELECTORS,
    ...challengeConfig.requiredSelectors,
  ].filter((selector, index, all) => all.indexOf(selector) === index);
  const failures = await page.evaluate(
    ({ selectors, requiredSelectors, opacityEpsilon }) => {
      const result: string[] = [];
      const documentWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
        window.innerWidth,
      );
      const documentHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
        window.innerHeight,
      );
      for (const selector of selectors as readonly string[]) {
        const elements = Array.from(document.querySelectorAll(selector));
        if (elements.length === 0) {
          if ((requiredSelectors as readonly string[]).includes(selector)) {
            result.push(`${selector} (missing)`);
          }
          continue;
        }
        elements.forEach((element, index) => {
          let effectiveOpacity = 1;
          const reasons: string[] = [];
          for (
            let ancestor: Element | null = element;
            ancestor !== null;
            ancestor = ancestor.parentElement
          ) {
            const style = getComputedStyle(ancestor);
            if (style.display === "none") reasons.push("display:none");
            if (style.visibility === "hidden" || style.visibility === "collapse") {
              reasons.push(`visibility:${style.visibility}`);
            }
            if (style.contentVisibility === "hidden") {
              reasons.push("content-visibility:hidden");
            }
            const opacity = Number.parseFloat(style.opacity);
            if (Number.isFinite(opacity)) effectiveOpacity *= opacity;
          }
          if (effectiveOpacity <= opacityEpsilon) {
            reasons.push(`effective opacity:${effectiveOpacity}`);
          }
          const rect = element.getBoundingClientRect();
          if (
            element.getClientRects().length === 0 ||
            rect.width <= 0 ||
            rect.height <= 0
          ) {
            reasons.push("zero-size or no client rect");
          }
          if (
            rect.right <= 0 ||
            rect.bottom <= 0 ||
            rect.left >= documentWidth ||
            rect.top >= documentHeight
          ) {
            reasons.push("off-document positioning");
          }
          if (reasons.length > 0) {
            result.push(
              `${selector}[${String(index)}] (${[...new Set(reasons)].join("; ")})`,
            );
          }
        });
      }
      return result;
    },
    {
      selectors,
      requiredSelectors,
      opacityEpsilon: 0.001,
    },
  );
  if (failures.length > 0) throw new GalleryContentVisibilityError(failures);
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

async function closeQuietly(
  resource: { close(): Promise<void> } | null,
): Promise<void> {
  if (resource !== null) await resource.close().catch(() => undefined);
}

async function assertScreenshotDimensions(path: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error("static page screenshot must be a regular file");
  }
  const metadata = await sharp(path).metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== 1440 ||
    metadata.height !== 1200
  ) {
    throw new Error("static page screenshot must be an exact 1440×1200 PNG");
  }
}

export async function renderStaticPage(
  input: StaticPageRenderInput,
  options: StaticPageRenderOptions = {},
): Promise<StaticPageRenderResult> {
  const externalRequests: string[] = [];
  let server: LoopbackStaticServer | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let temporaryScreenshotPath: string | null = null;
  try {
    server = await (options.startServer ?? startLoopbackStaticServer)({
      rootPath: input.rootPath,
      entryFile: input.entryFile,
    });
    browser = await (
      options.launchBrowser ?? (() => chromium.launch({ headless: true }))
    )();
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
    await page.goto(`${server.origin}/${input.entryFile.replace(/^\/+/, "")}`, {
      waitUntil: "domcontentloaded",
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.waitForTimeout(16);
    if (externalRequests.length > 0) {
      throw new StaticPageNetworkError(externalRequests);
    }
    if (input.verifyGalleryContent === true) {
      await assertGalleryContentVisibility(page, input.challengeConfig);
    }
    await mkdir(dirname(input.screenshotPath), { recursive: true });
    temporaryScreenshotPath = `${input.screenshotPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    if (options.screenshot === undefined) {
      await page.screenshot({
        path: temporaryScreenshotPath,
        fullPage: false,
        type: "png",
      });
    } else {
      await options.screenshot(page, temporaryScreenshotPath);
    }
    await assertScreenshotDimensions(temporaryScreenshotPath);
    await rename(temporaryScreenshotPath, input.screenshotPath);
    temporaryScreenshotPath = null;
    return {
      screenshotPath: input.screenshotPath,
      externalRequests,
      observedVersions: {
        playwright: NOT_RECORDED,
        chromium: browser.version(),
      },
    };
  } finally {
    if (temporaryScreenshotPath !== null) {
      await rm(temporaryScreenshotPath, { force: true }).catch(() => undefined);
    }
    await closeQuietly(page === null ? null : { close: () => page!.close() });
    await closeQuietly(context === null ? null : { close: () => context!.close() });
    await closeQuietly(browser === null ? null : { close: () => browser!.close() });
    await closeQuietly(server);
  }
}

export class StaticPageRenderer {
  private readonly options: StaticPageRenderOptions;

  public constructor(options: StaticPageRenderOptions = {}) {
    this.options = options;
  }

  public render(input: StaticPageRenderInput): Promise<StaticPageRenderResult> {
    return renderStaticPage(input, this.options);
  }
}
