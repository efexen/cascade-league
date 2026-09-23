import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import sharp from "sharp";

import type { ChallengeConfig } from "../schemas/index.js";
import {
  startLoopbackStaticServer,
  type LoopbackStaticServer,
} from "./static-server.js";
import { publishFilePairAtomically } from "./atomic-pair.js";

const NOT_RECORDED = "not-recorded";

export interface StaticPageRenderInput {
  readonly rootPath: string;
  readonly entryFile: string;
  readonly screenshotPath: string;
  readonly viewportScreenshotPath?: string;
  readonly challengeConfig: ChallengeConfig;
}

export interface StaticPageRenderOptions {
  readonly launchBrowser?: () => Promise<Browser>;
  readonly startServer?: typeof startLoopbackStaticServer;
  readonly screenshot?: (page: Page, path: string) => Promise<void>;
  readonly moveFile?: typeof rename;
}

export interface StaticPageRenderResult {
  readonly screenshotPath: string;
  readonly viewportScreenshotPath?: string;
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

async function assertScreenshotDimensions(
  path: string,
  expectedWidth: number,
  expectedHeight: number,
  label: string,
): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  const metadata = await sharp(path).metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== expectedWidth ||
    metadata.height !== expectedHeight
  ) {
    throw new Error(
      `${label} must be an exact ${String(expectedWidth)}×${String(expectedHeight)} PNG`,
    );
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
      waitUntil: "load",
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.waitForTimeout(16);
    if (externalRequests.length > 0) {
      throw new StaticPageNetworkError(externalRequests);
    }
    const FULL_HEIGHT_CAP = 12000;
    const expectedWidth = input.challengeConfig.viewport.width;
    const expectedViewportHeight = input.challengeConfig.viewport.height;
    const viewportPath =
      input.viewportScreenshotPath ??
      join(dirname(input.screenshotPath), "screenshot-viewport.png");
    const documentHeight = await page.evaluate(() => {
      try {
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
        if (finite.length === 0) return window.innerHeight;
        return Math.max(...finite);
      } catch {
        return window.innerHeight;
      }
    });
    const safeHeight = Number.isFinite(documentHeight)
      ? Math.max(1, Math.floor(documentHeight))
      : expectedViewportHeight;
    const cappedHeight = Math.min(safeHeight, FULL_HEIGHT_CAP);
    await mkdir(dirname(input.screenshotPath), { recursive: true });
    await mkdir(dirname(viewportPath), { recursive: true });
    temporaryScreenshotPath = `${input.screenshotPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    const viewportTemporaryPath = `${viewportPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    let viewportTemporaryActive = false;
    try {
      if (options.screenshot === undefined) {
        const cdp = await context.newCDPSession(page);
        try {
          const capture = await cdp.send("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: expectedWidth, height: cappedHeight, scale: 1 },
          });
          await writeFile(
            temporaryScreenshotPath,
            Buffer.from(capture.data as string, "base64"),
          );
        } finally {
          await cdp.detach().catch(() => undefined);
        }
        await assertScreenshotDimensions(
          temporaryScreenshotPath,
          expectedWidth,
          cappedHeight,
          "static page screenshot",
        );
        viewportTemporaryActive = true;
        await page.screenshot({
          path: viewportTemporaryPath,
          fullPage: false,
          type: "png",
        });
        await assertScreenshotDimensions(
          viewportTemporaryPath,
          expectedWidth,
          expectedViewportHeight,
          "static page viewport screenshot",
        );
        await publishFilePairAtomically(
          {
            firstTemporaryPath: temporaryScreenshotPath,
            firstDestinationPath: input.screenshotPath,
            secondTemporaryPath: viewportTemporaryPath,
            secondDestinationPath: viewportPath,
          },
          options.moveFile === undefined ? {} : { moveFile: options.moveFile },
        );
        temporaryScreenshotPath = null;
        viewportTemporaryActive = false;
      } else {
        await options.screenshot(page, temporaryScreenshotPath);
        await assertScreenshotDimensions(
          temporaryScreenshotPath,
          expectedWidth,
          cappedHeight,
          "static page screenshot",
        );
        await rename(temporaryScreenshotPath, input.screenshotPath);
        temporaryScreenshotPath = null;
      }
    } catch (error) {
      if (temporaryScreenshotPath !== null) {
        await rm(temporaryScreenshotPath, { force: true }).catch(() => undefined);
        temporaryScreenshotPath = null;
      }
      if (viewportTemporaryActive) {
        await rm(viewportTemporaryPath, { force: true }).catch(() => undefined);
        viewportTemporaryActive = false;
      }
      throw error;
    } finally {
      if (viewportTemporaryActive) {
        await rm(viewportTemporaryPath, { force: true }).catch(() => undefined);
      }
    }
    return {
      screenshotPath: input.screenshotPath,
      ...(options.screenshot === undefined
        ? { viewportScreenshotPath: viewportPath }
        : {}),
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
