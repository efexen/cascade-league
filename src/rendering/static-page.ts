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
  readonly verifyGalleryContent?: boolean;
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
  ".entry-runtime",
  ".entry-estimated-cost",
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
  ".judge-matrix",
  ".judge-matrix caption",
  ".judge-matrix-row",
  ".judge-matrix-row > th",
  ".judge-matrix-cell",
  ".judge-matrix-combined",
  ".judge-matrix-range",
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
      const displacementLimit = Math.max(window.innerWidth, window.innerHeight) * 8;
      const containingBlockTolerance = 2;

      const helpers = {
        alphaFromColor(value: string): number | null {
          const normalized = value.trim().toLowerCase();
          if (normalized === "transparent") return 0;
          if (/^#[0-9a-f]{4}$/u.test(normalized)) {
            const alpha = normalized.slice(4, 5);
            const parsed = Number.parseInt(`${alpha}${alpha}`, 16) / 255;
            return Number.isFinite(parsed) ? parsed : null;
          }
          if (/^#[0-9a-f]{8}$/u.test(normalized)) {
            const alpha = normalized.slice(-2);
            const parsed = Number.parseInt(alpha, 16) / 255;
            return Number.isFinite(parsed) ? parsed : null;
          }
          if (/^#[0-9a-f]{3}$/u.test(normalized)) return 1;
          if (/^#[0-9a-f]{6}$/u.test(normalized)) return 1;
          const functionStart = normalized.indexOf("(");
          if (functionStart > 0 && normalized.endsWith(")")) {
            const functionName = normalized.slice(0, functionStart);
            const body = normalized.slice(functionStart + 1, -1);
            const slashIndex = body.lastIndexOf("/");
            const parts = body.split(/[,\s/]+/u).filter(function (part) {
              return part !== "";
            });
            const alpha =
              slashIndex >= 0
                ? body
                    .slice(slashIndex + 1)
                    .trim()
                    .split(/\s+/u)[0]
                : /^(?:rgba|hsla)$/u.test(functionName)
                  ? parts[3]
                  : undefined;
            if (alpha === undefined || alpha === "none") return 1;
            const parsed = alpha.endsWith("%")
              ? Number.parseFloat(alpha) / 100
              : Number.parseFloat(alpha);
            return Number.isFinite(parsed) ? parsed : null;
          }
          return null;
        },

        colorTokens(value: string): string[] {
          return (
            value
              .replace(/url\([^)]*\)/giu, "")
              .match(
                /transparent|(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\([^)]*\)|#[0-9a-f]{3,8}\b/giu,
              ) ?? []
          );
        },

        splitCommaSeparated(value: string): string[] {
          const parts: string[] = [];
          let depth = 0;
          let start = 0;
          for (let index = 0; index < value.length; index += 1) {
            const character = value[index];
            if (character === "(") {
              depth += 1;
            } else if (character === ")") {
              depth = Math.max(0, depth - 1);
            } else if (character === "," && depth === 0) {
              parts.push(value.slice(start, index).trim());
              start = index + 1;
            }
          }
          parts.push(value.slice(start).trim());
          return parts.filter((part) => part !== "");
        },

        isFullyTransparentMask(value: string): boolean {
          if (value.trim().toLowerCase() === "none") return false;
          const tokens = this.colorTokens(value);
          if (tokens.length === 0) return false;
          for (const token of tokens) {
            const alpha = helpers.alphaFromColor(token);
            if (alpha === null || alpha > opacityEpsilon) return false;
          }
          return true;
        },

        isFullyTransparentFilter(value: string): boolean {
          if (value.trim().toLowerCase() === "none") return false;
          return [...value.matchAll(/opacity\(\s*([\d.]+)%?\s*\)/giu)].some(
            function (match) {
              return Number.parseFloat(match[1] ?? "1") <= opacityEpsilon;
            },
          );
        },

        parseClipLength(value: string, size: number): number | null {
          const normalized = value.trim().toLowerCase();
          if (normalized.endsWith("%")) {
            const percentage = Number.parseFloat(normalized);
            return Number.isFinite(percentage) ? (percentage / 100) * size : null;
          }
          const pixels = Number.parseFloat(normalized);
          return Number.isFinite(pixels) ? pixels : null;
        },

        hasZeroAreaClipPath(value: string, rect: DOMRect): boolean {
          const normalized = value.trim().toLowerCase();
          if (normalized === "none") return false;
          const insetMatch = normalized.match(/^inset\(([^)]*)\)/u);
          if (insetMatch !== null) {
            const insetValues =
              (insetMatch[1] ?? "")
                .split("/")[0]
                ?.trim()
                .split(/\s+/u)
                .filter(function (part) {
                  return part !== "";
                }) ?? [];
            if (insetValues.length > 0 && insetValues.length <= 4) {
              const expanded = [
                insetValues[0],
                insetValues[1] ?? insetValues[0],
                insetValues[2] ?? insetValues[0],
                insetValues[3] ?? insetValues[1] ?? insetValues[0],
              ];
              const top = this.parseClipLength(expanded[0] ?? "", rect.height);
              const right = this.parseClipLength(expanded[1] ?? "", rect.width);
              const bottom = this.parseClipLength(expanded[2] ?? "", rect.height);
              const left = this.parseClipLength(expanded[3] ?? "", rect.width);
              if (
                top !== null &&
                right !== null &&
                bottom !== null &&
                left !== null &&
                (top + bottom >= rect.height || left + right >= rect.width)
              ) {
                return true;
              }
            }
          }
          const circleMatch = normalized.match(/^circle\(\s*([^\s)]+)/u);
          if (circleMatch !== null) {
            const radius = this.parseClipLength(
              circleMatch[1] ?? "",
              Math.min(rect.width, rect.height),
            );
            if (radius !== null && radius <= 0) return true;
          }
          const ellipseMatch = normalized.match(/^ellipse\(\s*([^\s)]+)\s+([^\s)]+)/u);
          if (ellipseMatch !== null) {
            const radiusX = this.parseClipLength(ellipseMatch[1] ?? "", rect.width);
            const radiusY = this.parseClipLength(ellipseMatch[2] ?? "", rect.height);
            if (
              radiusX !== null &&
              radiusY !== null &&
              (radiusX <= 0 || radiusY <= 0)
            ) {
              return true;
            }
          }
          const polygonMatch = normalized.match(/^polygon\(([^)]*)\)/u);
          if (polygonMatch !== null) {
            const points = (polygonMatch[1] ?? "")
              .split(",")
              .map(function (point) {
                return point.trim().split(/\s+/u).map(Number);
              })
              .filter(function (point): point is [number, number] {
                return (
                  point.length >= 2 &&
                  Number.isFinite(point[0]) &&
                  Number.isFinite(point[1])
                );
              });
            if (points.length >= 3) {
              let area = 0;
              for (const [index, point] of points.entries()) {
                const next = points[(index + 1) % points.length]!;
                area += point[0] * next[1] - next[0] * point[1];
              }
              if (Math.abs(area) <= 0.001) return true;
            }
          }
          return false;
        },

        clipPathExcludesRect(
          value: string,
          rect: DOMRect,
          clippedElement: Element,
        ): boolean {
          if (this.hasZeroAreaClipPath(value, rect)) return true;
          const left = Math.max(0, rect.left);
          const right = Math.min(window.innerWidth, rect.right);
          const top = Math.max(0, rect.top);
          const bottom = Math.min(window.innerHeight, rect.bottom);
          if (right <= left || bottom <= top) return false;
          const inlineStyle = (clippedElement as HTMLElement).style;
          const originalPointerEvents = inlineStyle.getPropertyValue("pointer-events");
          const originalPointerEventsPriority =
            inlineStyle.getPropertyPriority("pointer-events");
          const needsPointerEventsOverride =
            getComputedStyle(clippedElement).pointerEvents === "none";
          if (needsPointerEventsOverride) {
            inlineStyle.setProperty("pointer-events", "auto", "important");
          }
          try {
            for (let xIndex = 0; xIndex < 5; xIndex += 1) {
              const x = left + ((right - left) * (xIndex + 0.5)) / 5;
              for (let yIndex = 0; yIndex < 5; yIndex += 1) {
                const y = top + ((bottom - top) * (yIndex + 0.5)) / 5;
                const hits = document.elementsFromPoint(x, y);
                if (
                  hits.some(function (hit) {
                    return hit === clippedElement || clippedElement.contains(hit);
                  })
                ) {
                  return false;
                }
              }
            }
            return true;
          } finally {
            if (needsPointerEventsOverride) {
              if (originalPointerEvents === "") {
                inlineStyle.removeProperty("pointer-events");
              } else {
                inlineStyle.setProperty(
                  "pointer-events",
                  originalPointerEvents,
                  originalPointerEventsPriority,
                );
              }
            }
          }
        },

        parseLength(value: string, reference: number): number | null {
          const normalized = value.trim().toLowerCase();
          if (normalized === "0" || normalized === "0px") return 0;
          if (normalized.endsWith("%")) {
            const percentage = Number.parseFloat(normalized);
            return Number.isFinite(percentage) ? (percentage / 100) * reference : null;
          }
          if (normalized.endsWith("px")) {
            const pixels = Number.parseFloat(normalized);
            return Number.isFinite(pixels) ? pixels : null;
          }
          return null;
        },

        parseMaskPosition(
          value: string,
          containerSize: number,
          maskSize: number | null,
        ): number | null {
          const normalized = value.trim().toLowerCase();
          if (normalized.endsWith("%")) {
            if (maskSize === null) return null;
            const percentage = Number.parseFloat(normalized);
            return Number.isFinite(percentage)
              ? ((containerSize - maskSize) * percentage) / 100
              : null;
          }
          return this.parseLength(normalized, containerSize);
        },

        maskGeometryExcludesRect(style: CSSStyleDeclaration, rect: DOMRect): boolean {
          const maskImageValues = [
            style.maskImage,
            style.getPropertyValue("-webkit-mask-image"),
          ];
          const maskImage =
            maskImageValues.find(
              (value) => value.trim() !== "" && value.trim().toLowerCase() !== "none",
            ) ?? "none";
          if (maskImage.trim().toLowerCase() === "none") return false;
          const maskSizeValues = [
            style.maskSize,
            style.getPropertyValue("-webkit-mask-size"),
          ];
          const maskSize =
            maskSizeValues.find(
              (value) => value.trim() !== "" && value.trim().toLowerCase() !== "auto",
            ) ??
            maskSizeValues[0] ??
            "";
          const sizeParts = (maskSize.split(",")[0] ?? "")
            .trim()
            .split(/\s+/u)
            .filter(function (part) {
              return part !== "";
            });
          const width = this.parseLength(sizeParts[0] ?? "", rect.width);
          const height = this.parseLength(
            sizeParts[1] ?? sizeParts[0] ?? "",
            rect.height,
          );
          if ((width !== null && width <= 0) || (height !== null && height <= 0)) {
            return true;
          }

          const maskRepeatValues = [
            style.maskRepeat,
            style.getPropertyValue("-webkit-mask-repeat"),
          ];
          const maskRepeat =
            maskRepeatValues.find((value) => value.includes("no-repeat")) ??
            maskRepeatValues[0] ??
            "";
          if (!maskRepeat.split(",")[0]?.trim().includes("no-repeat")) {
            return false;
          }
          const maskPositionValues = [
            style.maskPosition,
            style.getPropertyValue("-webkit-mask-position"),
          ];
          const maskPosition =
            maskPositionValues.find(
              (value) => value.trim() !== "" && value.trim() !== "0% 0%",
            ) ??
            maskPositionValues[0] ??
            "";
          const positionParts = (maskPosition.split(",")[0] ?? "")
            .trim()
            .split(/\s+/u)
            .filter(function (part) {
              return part !== "";
            });
          const left = this.parseMaskPosition(
            positionParts[0] ?? "",
            rect.width,
            width,
          );
          const top = this.parseMaskPosition(
            positionParts[1] ?? positionParts[0] ?? "",
            rect.height,
            height,
          );
          if (
            (left !== null && Math.abs(left) > displacementLimit) ||
            (top !== null && Math.abs(top) > displacementLimit)
          ) {
            return true;
          }
          if (left !== null && top !== null && width !== null && height !== null) {
            const maskLeft = rect.left + left;
            const maskTop = rect.top + top;
            return (
              maskLeft + width <= rect.left ||
              maskLeft >= rect.right ||
              maskTop + height <= rect.top ||
              maskTop >= rect.bottom
            );
          }
          return false;
        },

        pseudoContainingRect(
          element: Element,
          position: string,
        ): {
          left: number;
          top: number;
          right: number;
          bottom: number;
          width: number;
          height: number;
        } {
          if (position === "fixed") {
            return {
              left: 0,
              top: 0,
              right: window.innerWidth,
              bottom: window.innerHeight,
              width: window.innerWidth,
              height: window.innerHeight,
            };
          }
          let containingBlock: Element | null = element;
          for (
            let ancestor = element.parentElement;
            ancestor !== null;
            ancestor = ancestor.parentElement
          ) {
            const style = getComputedStyle(ancestor);
            if (
              style.position !== "static" ||
              style.transform !== "none" ||
              style.perspective !== "none" ||
              style.filter !== "none"
            ) {
              containingBlock = ancestor;
              break;
            }
          }
          if (containingBlock === null) {
            return {
              left: 0,
              top: 0,
              right: window.innerWidth,
              bottom: window.innerHeight,
              width: window.innerWidth,
              height: window.innerHeight,
            };
          }
          const rect = containingBlock.getBoundingClientRect();
          return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          };
        },

        pseudoRect(
          element: Element,
          style: CSSStyleDeclaration,
        ): {
          left: number;
          top: number;
          right: number;
          bottom: number;
          width: number;
          height: number;
        } | null {
          const containing = this.pseudoContainingRect(element, style.position);
          const leftInset = this.parseLength(style.left, containing.width);
          const rightInset = this.parseLength(style.right, containing.width);
          const topInset = this.parseLength(style.top, containing.height);
          const bottomInset = this.parseLength(style.bottom, containing.height);
          const width = this.parseLength(style.width, containing.width);
          const height = this.parseLength(style.height, containing.height);
          let left: number;
          let right: number;
          let top: number;
          let bottom: number;
          if (leftInset !== null && rightInset !== null && width === null) {
            left = containing.left + leftInset;
            right = containing.right - rightInset;
          } else if (leftInset !== null && width !== null) {
            left = containing.left + leftInset;
            right = left + width;
          } else if (rightInset !== null && width !== null) {
            right = containing.right - rightInset;
            left = right - width;
          } else {
            return null;
          }
          if (topInset !== null && bottomInset !== null && height === null) {
            top = containing.top + topInset;
            bottom = containing.bottom - bottomInset;
          } else if (topInset !== null && height !== null) {
            top = containing.top + topInset;
            bottom = top + height;
          } else if (bottomInset !== null && height !== null) {
            bottom = containing.bottom - bottomInset;
            top = bottom - height;
          } else {
            return null;
          }
          return {
            left,
            top,
            right,
            bottom,
            width: right - left,
            height: bottom - top,
          };
        },

        hasCoveringInsetBoxShadow(
          style: CSSStyleDeclaration,
          pseudoRect: {
            left: number;
            top: number;
            right: number;
            bottom: number;
            width: number;
            height: number;
          },
          textRect: DOMRect,
        ): boolean {
          const shadow = style.boxShadow.trim().toLowerCase();
          if (shadow === "none") return false;
          for (const layer of this.splitCommaSeparated(shadow)) {
            if (!/\binset\b/iu.test(layer)) continue;
            const shadowColors = this.colorTokens(layer);
            const hasPaintedColor =
              shadowColors.length === 0 ||
              shadowColors.some(function (color) {
                const alpha = helpers.alphaFromColor(color);
                return alpha === null || alpha > opacityEpsilon;
              });
            if (!hasPaintedColor) continue;
            const lengthSource = this.colorTokens(layer).reduce(
              (remaining, color) => remaining.replace(color, " "),
              layer.replace(/\binset\b/giu, " "),
            );
            const lengths =
              lengthSource.match(
                /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:[a-z%]+)?/giu,
              ) ?? [];
            if (lengths.length < 4) continue;
            const offsetX = this.parseLength(lengths[0]!, pseudoRect.width);
            const offsetY = this.parseLength(lengths[1]!, pseudoRect.height);
            const blur = this.parseLength(
              lengths[2]!,
              Math.max(pseudoRect.width, pseudoRect.height),
            );
            const spread = this.parseLength(
              lengths[3]!,
              Math.max(pseudoRect.width, pseudoRect.height),
            );
            if (
              offsetX === null ||
              offsetY === null ||
              blur === null ||
              spread === null
            ) {
              continue;
            }
            const reach =
              Math.max(0, spread) +
              Math.max(0, blur * 2) +
              Math.max(Math.abs(offsetX), Math.abs(offsetY));
            if (reach >= Math.max(pseudoRect.width, pseudoRect.height)) return true;
            const textWithinLeftBand =
              textRect.left >= pseudoRect.left &&
              textRect.right <= pseudoRect.left + reach;
            const textWithinRightBand =
              textRect.left >= pseudoRect.right - reach &&
              textRect.right <= pseudoRect.right;
            const textWithinTopBand =
              textRect.top >= pseudoRect.top &&
              textRect.bottom <= pseudoRect.top + reach;
            const textWithinBottomBand =
              textRect.top >= pseudoRect.bottom - reach &&
              textRect.bottom <= pseudoRect.bottom;
            if (
              textWithinLeftBand ||
              textWithinRightBand ||
              textWithinTopBand ||
              textWithinBottomBand
            ) {
              return true;
            }
          }
          return false;
        },

        hasVisiblePseudoPaint(
          style: CSSStyleDeclaration,
          pseudoRect: {
            left: number;
            top: number;
            right: number;
            bottom: number;
            width: number;
            height: number;
          },
          textRect: DOMRect,
        ): boolean {
          const content = style.content.trim().toLowerCase();
          if (content === "none" || content === "normal") return false;
          const opacity = Number.parseFloat(style.opacity);
          if (Number.isFinite(opacity) && opacity <= opacityEpsilon) return false;
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            this.isFullyTransparentFilter(style.filter) ||
            this.isFullyTransparentMask(style.maskImage) ||
            this.isFullyTransparentMask(style.getPropertyValue("-webkit-mask-image"))
          ) {
            return false;
          }
          const colorAlpha = this.alphaFromColor(style.color);
          const fillAlpha = this.alphaFromColor(
            style.getPropertyValue("-webkit-text-fill-color"),
          );
          const hasGeneratedText =
            content !== '""' &&
            content !== "''" &&
            (fillAlpha === null
              ? colorAlpha === null || colorAlpha > opacityEpsilon
              : fillAlpha > opacityEpsilon);
          const backgroundAlpha = this.alphaFromColor(style.backgroundColor);
          const hasBackground =
            (backgroundAlpha !== null && backgroundAlpha > opacityEpsilon) ||
            (style.backgroundImage !== "none" &&
              !this.isFullyTransparentMask(style.backgroundImage));
          return (
            hasGeneratedText ||
            hasBackground ||
            this.hasCoveringInsetBoxShadow(style, pseudoRect, textRect)
          );
        },

        hasPaintedTextDecoration(
          style: CSSStyleDeclaration,
          textRect: DOMRect,
        ): boolean {
          const shadow = style.textShadow.trim().toLowerCase();
          if (shadow !== "none") {
            for (const layer of this.splitCommaSeparated(shadow)) {
              const shadowColors = this.colorTokens(layer);
              const hasPaintedColor =
                shadowColors.length === 0 ||
                shadowColors.some(function (color) {
                  const alpha = helpers.alphaFromColor(color);
                  return alpha === null || alpha > opacityEpsilon;
                });
              if (!hasPaintedColor) continue;
              const lengthSource = this.colorTokens(layer).reduce(
                (remaining, color) => remaining.replace(color, " "),
                layer,
              );
              const lengths =
                lengthSource.match(
                  /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:[a-z%]+)?/giu,
                ) ?? [];
              if (lengths.length < 2) continue;
              const offsetX = this.parseLength(lengths[0]!, textRect.width);
              const offsetY = this.parseLength(lengths[1]!, textRect.height);
              const blur =
                lengths[2] === undefined
                  ? 0
                  : this.parseLength(
                      lengths[2],
                      Math.max(textRect.width, textRect.height),
                    );
              if (offsetX === null || offsetY === null || blur === null) continue;
              const blurReach = Math.max(1, blur * 2);
              const shadowLeft = textRect.left + offsetX - blurReach;
              const shadowRight = textRect.right + offsetX + blurReach;
              const shadowTop = textRect.top + offsetY - blurReach;
              const shadowBottom = textRect.bottom + offsetY + blurReach;
              if (
                shadowRight > textRect.left &&
                shadowLeft < textRect.right &&
                shadowBottom > textRect.top &&
                shadowTop < textRect.bottom
              ) {
                return true;
              }
            }
          }
          const strokeWidth =
            style.getPropertyValue("-webkit-text-stroke-width") ||
            style.getPropertyValue("text-stroke-width");
          const strokeColor =
            style.getPropertyValue("-webkit-text-stroke-color") ||
            style.getPropertyValue("text-stroke-color");
          const width = this.parseLength(strokeWidth, 1);
          const alpha = this.alphaFromColor(strokeColor);
          return (
            width !== null &&
            width > opacityEpsilon &&
            (alpha === null || alpha > opacityEpsilon)
          );
        },

        coversTextWithPseudo(
          element: Element,
          textRect: DOMRect,
          pseudo: "::before" | "::after",
        ): boolean {
          const style = getComputedStyle(element, pseudo);
          if (style.position !== "absolute" && style.position !== "fixed") return false;
          const zIndex =
            style.zIndex === "auto" ? null : Number.parseInt(style.zIndex, 10);
          if (zIndex !== null && (!Number.isFinite(zIndex) || zIndex < 0)) return false;
          if (pseudo === "::before" && zIndex === null) return false;
          const pseudoRect = this.pseudoRect(element, style);
          if (
            pseudoRect === null ||
            pseudoRect.width <= 0 ||
            pseudoRect.height <= 0 ||
            !this.hasVisiblePseudoPaint(style, pseudoRect, textRect)
          ) {
            return false;
          }
          return (
            pseudoRect.left <= textRect.left &&
            pseudoRect.right >= textRect.right &&
            pseudoRect.top <= textRect.top &&
            pseudoRect.bottom >= textRect.bottom
          );
        },

        transformTranslation(value: string): number {
          const numbers = value.match(/-?[\d.]+/gu)?.map(Number) ?? [];
          if (value.startsWith("matrix3d(") && numbers.length >= 14) {
            return Math.max(Math.abs(numbers[12] ?? 0), Math.abs(numbers[13] ?? 0));
          }
          if (value.startsWith("matrix(") && numbers.length >= 6) {
            return Math.max(Math.abs(numbers[4] ?? 0), Math.abs(numbers[5] ?? 0));
          }
          return 0;
        },

        hasExcessiveDisplacement(style: CSSStyleDeclaration): boolean {
          const offsets = [
            style.top,
            style.right,
            style.bottom,
            style.left,
            style.marginTop,
            style.marginRight,
            style.marginBottom,
            style.marginLeft,
            style.paddingTop,
            style.paddingRight,
            style.paddingBottom,
            style.paddingLeft,
          ];
          return (
            offsets.some(function (value) {
              const parsed = Number.parseFloat(value);
              return Number.isFinite(parsed) && Math.abs(parsed) > displacementLimit;
            }) || this.transformTranslation(style.transform) > displacementLimit
          );
        },

        hasPaintedText(element: Element): { painted: boolean; covered: boolean } {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let textNode = walker.nextNode();
          while (textNode !== null) {
            if ((textNode.textContent ?? "").trim() !== "") {
              const parent = textNode.parentElement;
              if (parent !== null) {
                const range = document.createRange();
                range.selectNodeContents(textNode);
                const textRect = Array.from(range.getClientRects()).find(
                  function (candidate) {
                    return candidate.width > 0 && candidate.height > 0;
                  },
                );
                range.detach();
                const elementRect = element.getBoundingClientRect();
                const textIntersectsElement =
                  textRect !== undefined &&
                  textRect.right > elementRect.left &&
                  textRect.left < elementRect.right &&
                  textRect.bottom > elementRect.top &&
                  textRect.top < elementRect.bottom;
                if (textIntersectsElement && textRect !== undefined) {
                  let effectiveOpacity = 1;
                  let painted = true;
                  let covered = false;
                  for (
                    let ancestor: Element | null = parent;
                    ancestor !== null;
                    ancestor = ancestor.parentElement
                  ) {
                    const style = getComputedStyle(ancestor);
                    if (
                      style.display === "none" ||
                      style.visibility === "hidden" ||
                      style.visibility === "collapse" ||
                      style.contentVisibility === "hidden" ||
                      this.isFullyTransparentFilter(style.filter) ||
                      this.isFullyTransparentMask(style.maskImage) ||
                      this.isFullyTransparentMask(
                        style.getPropertyValue("-webkit-mask-image"),
                      ) ||
                      this.maskGeometryExcludesRect(
                        style,
                        ancestor.getBoundingClientRect(),
                      )
                    ) {
                      painted = false;
                      break;
                    }
                    const opacity = Number.parseFloat(style.opacity);
                    if (Number.isFinite(opacity)) effectiveOpacity *= opacity;
                    if (
                      style.clipPath !== "none" &&
                      this.clipPathExcludesRect(style.clipPath, textRect, ancestor)
                    ) {
                      painted = false;
                      break;
                    }
                    if (
                      this.coversTextWithPseudo(ancestor, textRect, "::before") ||
                      this.coversTextWithPseudo(ancestor, textRect, "::after")
                    ) {
                      painted = false;
                      covered = true;
                      break;
                    }
                    const colorAlpha = this.alphaFromColor(style.color);
                    const fillAlpha = this.alphaFromColor(
                      style.getPropertyValue("-webkit-text-fill-color"),
                    );
                    const backgroundClip = `${style.backgroundClip} ${style.getPropertyValue(
                      "-webkit-background-clip",
                    )}`;
                    const hasTextBackground =
                      /(?:^|\s|,)text(?:\s|,|$)/iu.test(backgroundClip) &&
                      style.backgroundImage !== "none";
                    const hasPaintedTextBackground =
                      hasTextBackground &&
                      !this.isFullyTransparentMask(style.backgroundImage);
                    const hasPaintedTextDecoration = this.hasPaintedTextDecoration(
                      style,
                      textRect,
                    );
                    if (
                      !hasPaintedTextBackground &&
                      !hasPaintedTextDecoration &&
                      ((colorAlpha !== null && colorAlpha <= opacityEpsilon) ||
                        (fillAlpha !== null && fillAlpha <= opacityEpsilon))
                    ) {
                      painted = false;
                      break;
                    }
                  }
                  if (painted && effectiveOpacity > opacityEpsilon) {
                    return { painted: true, covered: false };
                  }
                  if (covered) return { painted: false, covered: true };
                }
              }
            }
            textNode = walker.nextNode();
          }
          return { painted: false, covered: false };
        },
      };

      for (const selector of selectors as readonly string[]) {
        const elements = Array.from(document.querySelectorAll(selector));
        if (elements.length === 0) {
          if ((requiredSelectors as readonly string[]).includes(selector)) {
            result.push(`${selector} (missing)`);
          }
          continue;
        }
        elements.forEach(function (element, index) {
          let effectiveOpacity = 1;
          const reasons: string[] = [];
          const rect = element.getBoundingClientRect();
          let hasPositioning = false;
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
            if (style.position !== "static" || style.transform !== "none") {
              hasPositioning = true;
            }
            if (helpers.hasExcessiveDisplacement(style)) {
              reasons.push("excessive displacement");
            }
            const opacity = Number.parseFloat(style.opacity);
            if (Number.isFinite(opacity)) effectiveOpacity *= opacity;

            if (ancestor !== element) {
              const ancestorRect = ancestor.getBoundingClientRect();
              if (ancestorRect.width <= 0 || ancestorRect.height <= 0) {
                reasons.push("clipped by zero-size ancestor");
              }
              const clipsX = /^(?:hidden|clip|scroll|auto)$/u.test(style.overflowX);
              const clipsY = /^(?:hidden|clip|scroll|auto)$/u.test(style.overflowY);
              if (
                (clipsX &&
                  (rect.right <= ancestorRect.left ||
                    rect.left >= ancestorRect.right)) ||
                (clipsY &&
                  (rect.bottom <= ancestorRect.top || rect.top >= ancestorRect.bottom))
              ) {
                reasons.push("clipped by ancestor");
              }
              if (
                hasPositioning &&
                (rect.right <= ancestorRect.left - containingBlockTolerance ||
                  rect.left >= ancestorRect.right + containingBlockTolerance ||
                  rect.bottom <= ancestorRect.top - containingBlockTolerance ||
                  rect.top >= ancestorRect.bottom + containingBlockTolerance)
              ) {
                reasons.push("displaced outside positioned ancestor");
              }
            }
            if (
              style.clipPath !== "none" &&
              helpers.clipPathExcludesRect(style.clipPath, rect, ancestor)
            ) {
              reasons.push("fully clipped");
            }
            if (
              helpers.maskGeometryExcludesRect(style, ancestor.getBoundingClientRect())
            ) {
              reasons.push("mask geometry excludes content");
            }
            if (
              helpers.isFullyTransparentFilter(style.filter) ||
              helpers.isFullyTransparentMask(style.maskImage) ||
              helpers.isFullyTransparentMask(
                style.getPropertyValue("-webkit-mask-image"),
              )
            ) {
              reasons.push("fully transparent paint effect");
            }
          }
          if (effectiveOpacity <= opacityEpsilon) {
            reasons.push(`effective opacity:${effectiveOpacity}`);
          }
          if (
            element.getClientRects().length === 0 ||
            rect.width <= 0 ||
            rect.height <= 0
          ) {
            reasons.push("zero-size or no client rect");
          }
          if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth) {
            reasons.push("off-document positioning");
          }
          if ((element.textContent ?? "").trim() !== "") {
            const textPaint = helpers.hasPaintedText(element);
            if (!textPaint.painted) {
              reasons.push(
                textPaint.covered
                  ? "text covered by pseudo-element"
                  : "text is not painted",
              );
            }
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
