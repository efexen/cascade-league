import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import sharp from "sharp";

import { ContactSheetOrderSchema, type ContactSheetOrder } from "../schemas/index.js";

export type ContactSheetStatus =
  | "valid"
  | "invalid"
  | "render_failed"
  | "timeout"
  | "missing_submission"
  | "execution_failed";

export interface ContactSheetCandidate {
  readonly anonymousCandidateId: string;
  readonly validationStatus: ContactSheetStatus;
  readonly screenshotPath: string | null;
}

export interface BuildAnonymousContactSheetInput {
  readonly generationId: string;
  readonly judgeId: string;
  readonly candidates: readonly ContactSheetCandidate[];
  readonly outputPath: string;
  readonly orderPath?: string;
  readonly seed?: string;
}

export interface AnonymousContactSheetResult {
  readonly seed: string;
  readonly candidateOrder: readonly string[];
  readonly outputPath: string;
  readonly orderPath: string | null;
}

const SHEET_WIDTH = 1600;
const SHEET_HEIGHT = 900;
const CELL_GAP = 16;
const CELL_PADDING = 12;
const LABEL_HEIGHT = 40;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function deterministicRank(seed: string, candidateId: string): string {
  return createHash("sha256").update(`${seed}\0${candidateId}`).digest("hex");
}

function orderedCandidates(
  candidates: readonly ContactSheetCandidate[],
  seed: string,
): ContactSheetCandidate[] {
  const ordered = [...candidates].sort((left, right) => {
    const leftRank = deterministicRank(seed, left.anonymousCandidateId);
    const rightRank = deterministicRank(seed, right.anonymousCandidateId);
    return leftRank < rightRank ? -1 : leftRank > rightRank ? 1 : 0;
  });
  const executionOrder = candidates.map((candidate) => candidate.anonymousCandidateId);
  if (
    ordered.length > 1 &&
    ordered.every(
      (candidate, index) => candidate.anonymousCandidateId === executionOrder[index],
    )
  ) {
    [ordered[0], ordered[1]] = [ordered[1]!, ordered[0]!];
  }
  return ordered;
}

function layoutFor(count: number): { readonly columns: number; readonly rows: number } {
  if (count <= 2) return { columns: count, rows: 1 };
  if (count <= 4) return { columns: 2, rows: 2 };
  return { columns: 3, rows: 2 };
}

function svgOverlay(
  cellWidth: number,
  cellHeight: number,
  candidate: ContactSheetCandidate,
): Buffer {
  const id = escapeXml(candidate.anonymousCandidateId);
  const status = escapeXml(candidate.validationStatus);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(cellWidth)}" height="${String(cellHeight)}"><rect y="${String(cellHeight - LABEL_HEIGHT)}" width="100%" height="${String(LABEL_HEIGHT)}" fill="#ffffff"/><text x="16" y="${String(cellHeight - 14)}" fill="#1d1d1b" font-family="Arial, sans-serif" font-size="16">${id} · ${status}</text></svg>`;
  return Buffer.from(svg);
}

async function atomicWrite(path: string, contents: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, contents);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function assertScreenshot(path: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error("contact-sheet screenshot must be a regular file");
  }
}

async function pathWasPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function buildAnonymousContactSheet(
  input: BuildAnonymousContactSheetInput,
): Promise<AnonymousContactSheetResult> {
  if (input.candidates.length < 1 || input.candidates.length > 6) {
    throw new Error("a Phase 1 contact sheet supports one to six candidates");
  }
  const ids = input.candidates.map((candidate) => candidate.anonymousCandidateId);
  if (new Set(ids).size !== ids.length)
    throw new Error("contact-sheet candidate IDs must be unique");
  const seed = input.seed ?? randomBytes(32).toString("hex");
  const ordered = orderedCandidates(input.candidates, seed);
  const order = ContactSheetOrderSchema.parse({
    schemaVersion: 1,
    generationId: input.generationId,
    judgeId: input.judgeId,
    seed,
    candidateOrder: ordered.map((candidate) => candidate.anonymousCandidateId),
  });
  const outputWasPresent = await pathWasPresent(input.outputPath);
  const orderWasPresent =
    input.orderPath === undefined ? false : await pathWasPresent(input.orderPath);
  try {
    const { columns, rows } = layoutFor(ordered.length);
    const cellWidth = Math.floor(SHEET_WIDTH / columns);
    const cellHeight = Math.floor(SHEET_HEIGHT / rows);
    const composites: {
      readonly input: Buffer;
      readonly left: number;
      readonly top: number;
    }[] = [];
    for (const [index, candidate] of ordered.entries()) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * cellWidth + CELL_GAP / 2;
      const y = row * cellHeight + CELL_GAP / 2;
      const actualCellWidth = Math.floor(SHEET_WIDTH / columns) - CELL_GAP;
      const actualCellHeight = Math.floor(SHEET_HEIGHT / rows) - CELL_GAP;
      const imageWidth = actualCellWidth - CELL_PADDING * 2;
      const imageHeight = actualCellHeight - LABEL_HEIGHT - CELL_PADDING * 2;
      let image: Buffer;
      if (candidate.screenshotPath === null) {
        image = await sharp({
          create: {
            width: imageWidth,
            height: imageHeight,
            channels: 4,
            background: "#deded9",
          },
        })
          .png({ compressionLevel: 9, adaptiveFiltering: false })
          .toBuffer();
      } else {
        await assertScreenshot(candidate.screenshotPath);
        image = await sharp(candidate.screenshotPath)
          .resize({
            width: imageWidth,
            height: imageHeight,
            fit: "contain",
            background: "#ffffff",
          })
          .png({ compressionLevel: 9, adaptiveFiltering: false })
          .toBuffer();
      }
      composites.push({
        input: image,
        left: Math.round(x + CELL_PADDING),
        top: Math.round(y + CELL_PADDING),
      });
      composites.push({
        input: svgOverlay(actualCellWidth, actualCellHeight, candidate),
        left: Math.round(x),
        top: Math.round(y),
      });
    }
    const png = await sharp({
      create: {
        width: SHEET_WIDTH,
        height: SHEET_HEIGHT,
        channels: 4,
        background: "#f2f2ef",
      },
    })
      .composite(composites)
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer();
    await atomicWrite(input.outputPath, png);
    if (input.orderPath !== undefined) {
      await atomicWrite(input.orderPath, `${JSON.stringify(order, null, 2)}\n`);
    }
    return {
      seed: order.seed,
      candidateOrder: order.candidateOrder,
      outputPath: input.outputPath,
      orderPath: input.orderPath ?? null,
    };
  } catch (error) {
    if (!outputWasPresent) {
      await rm(input.outputPath, { force: true }).catch(() => undefined);
    }
    if (input.orderPath !== undefined && !orderWasPresent) {
      await rm(input.orderPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export type { ContactSheetOrder };
