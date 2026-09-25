import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";

import { PublicMetadataSchema } from "../gallery/builder.js";
import { renderDesignViewer, type ViewerEntry } from "../gallery/builder.js";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const GENERATION_ID = /^\d{4}$/u;
const GENERATION_FILES = new Set([
  "champion.css",
  "designs",
  "fonts",
  "gallery-layout.css",
  "gallery-screenshot.png",
  "gallery-viewport.png",
  "index.html",
  "metadata.json",
  "screenshots",
]);

export interface BackfillViewersOptions {
  readonly sitePath: string;
  readonly seasonId: string;
  readonly dryRun?: boolean;
}

export interface BackfillViewersResult {
  readonly changedFiles: readonly string[];
  readonly generations: number;
  readonly viewers: number;
  readonly dryRun: boolean;
}

interface PlannedWrite {
  readonly path: string;
  readonly content: string;
  readonly relativePath: string;
  readonly exclusive: boolean;
}

interface GenerationPlan {
  readonly writes: readonly PlannedWrite[];
  readonly viewers: number;
}

function fail(message: string): never {
  throw new Error(`viewer backfill refused: ${message}`);
}

async function regularFile(path: string, description: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      fail(`${description} is missing`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    fail(`${description} must be a regular file`);
  if (stat.nlink !== 1) fail(`${description} must not be hard-linked`);
}

async function directory(path: string, description: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      fail(`${description} is missing`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    fail(`${description} must be a directory`);
}

function parseLinks(html: string): { ids: string[]; screenshots: string[] } {
  const ids: string[] = [];
  const screenshots: string[] = [];
  for (const match of html.matchAll(/\bhref="(designs\/[^"\s]+)"/gu)) {
    const target = match[1]!;
    const parsed = /^designs\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(index|view)\.html$/u.exec(
      target,
    );
    if (parsed === null) fail(`unexpected design link ${target}`);
    ids.push(parsed[1]!);
  }
  for (const match of html.matchAll(/\bsrc="(screenshots\/[^"\s]+)"/gu)) {
    const target = match[1]!;
    if (!/^screenshots\/entry-\d{3}\.png$/u.test(target)) {
      fail(`unexpected entry screenshot link ${target}`);
    }
    screenshots.push(target);
  }
  const allDesignTargets = [...html.matchAll(/\bhref="([^"]*designs\/[^""]*)"/gu)];
  if (allDesignTargets.length !== ids.length)
    fail("gallery contains an unsupported design link");
  return { ids, screenshots };
}

function relativePosix(from: string, target: string): string {
  return relative(from, target).split(sep).join("/");
}

async function planGeneration(
  sitePath: string,
  seasonId: string,
  generationId: string,
  generationPath: string,
): Promise<GenerationPlan> {
  await directory(generationPath, `generation ${generationId}`);
  const childNames = (await readdir(generationPath)).sort();
  const unexpected = childNames.filter((name) => !GENERATION_FILES.has(name));
  if (unexpected.length > 0)
    fail(`generation ${generationId} has unexpected paths: ${unexpected.join(", ")}`);
  for (const required of ["designs", "screenshots"]) {
    await directory(
      join(generationPath, required),
      `generation ${generationId}/${required}`,
    );
  }

  const metadataPath = join(generationPath, "metadata.json");
  const indexPath = join(generationPath, "index.html");
  await regularFile(metadataPath, `generation ${generationId}/metadata.json`);
  await regularFile(indexPath, `generation ${generationId}/index.html`);
  let metadata: z.infer<typeof PublicMetadataSchema>;
  try {
    metadata = PublicMetadataSchema.parse(
      JSON.parse(await readFile(metadataPath, "utf8")) as unknown,
    );
  } catch (error) {
    fail(
      `generation ${generationId} metadata is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (metadata.seasonId !== seasonId || metadata.generationId !== generationId) {
    fail(`generation ${generationId} metadata path identity does not match`);
  }
  for (const entry of metadata.entries) {
    if (!ID.test(entry.contestantId))
      fail(`invalid contestant path ID ${entry.contestantId}`);
  }

  const html = await readFile(indexPath, "utf8");
  const links = parseLinks(html);
  const screenshotSequence = metadata.entries.map(
    (_, index) => `screenshots/entry-${String(index + 1).padStart(3, "0")}.png`,
  );
  if (JSON.stringify(links.screenshots) !== JSON.stringify(screenshotSequence)) {
    fail(`generation ${generationId} screenshot links do not match metadata order`);
  }
  for (const screenshotPath of screenshotSequence) {
    await regularFile(
      join(generationPath, screenshotPath),
      `generation ${generationId}/${screenshotPath}`,
    );
  }

  const mapped: Array<{
    entry: (typeof metadata.entries)[number];
    screenshotPath: string;
  }> = [];
  const expectedIds: string[] = [];
  const screenshotNames = await readdir(join(generationPath, "screenshots"));
  const writes: PlannedWrite[] = [];
  for (let index = 0; index < metadata.entries.length; index += 1) {
    const entry = metadata.entries[index]!;
    const rawPath = join(generationPath, "designs", entry.contestantId, "index.html");
    let rawExists = false;
    try {
      const status = await lstat(rawPath);
      if (status.isSymbolicLink() || !status.isFile())
        fail(`${entry.contestantId}/index.html must be a regular file`);
      if (status.nlink !== 1)
        fail(`${entry.contestantId}/index.html must not be hard-linked`);
      rawExists = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw error;
    }
    const designDirectory = join(generationPath, "designs", entry.contestantId);
    try {
      const designStat = await lstat(designDirectory);
      if (designStat.isSymbolicLink() || !designStat.isDirectory())
        fail(`${entry.contestantId} design path must be a directory`);
      if (!rawExists) fail(`${entry.contestantId} design directory has no index.html`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw error;
    }
    if (rawExists) {
      const screenshotPath = screenshotSequence[index]!;
      const fullPath = screenshotPath.replace(/\.png$/u, "-full.png");
      if (!screenshotNames.includes(fullPath.slice("screenshots/".length))) {
        fail(`generation ${generationId}/${fullPath} is missing`);
      }
      await regularFile(
        join(generationPath, fullPath),
        `generation ${generationId}/${fullPath}`,
      );
      expectedIds.push(entry.contestantId);
      mapped.push({ entry, screenshotPath });
    }
  }
  if (
    links.ids.length !== expectedIds.length ||
    links.ids.some((id, index) => id !== expectedIds[index])
  ) {
    fail(`generation ${generationId} design links do not match published raw pages`);
  }
  const designDirectories = await readdir(join(generationPath, "designs"));
  if (designDirectories.some((name) => !expectedIds.includes(name))) {
    fail(`generation ${generationId} designs directory contains an unlisted design`);
  }

  const viewerEntries: ViewerEntry[] = mapped.map(({ entry, screenshotPath }) => ({
    contestantId: entry.contestantId,
    displayName: entry.displayName,
    rank: entry.rank,
    statusLabel: entry.status,
    screenshotPath,
  }));
  for (const entry of viewerEntries) {
    const path = join(generationPath, "designs", entry.contestantId, "view.html");
    const content = renderDesignViewer(seasonId, generationId, entry, viewerEntries);
    let exists = false;
    try {
      await regularFile(path, `${entry.contestantId}/view.html`);
      exists = true;
      if ((await readFile(path, "utf8")) !== content)
        fail(`${entry.contestantId}/view.html exists with unexpected content`);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("is missing")))
        throw error;
    }
    if (!exists) {
      writes.push({
        path,
        relativePath: relativePosix(sitePath, path),
        content,
        exclusive: true,
      });
    }
  }

  let updatedHtml = html;
  for (const entry of viewerEntries) {
    const from = `href="designs/${entry.contestantId}/index.html"`;
    const to = `href="designs/${entry.contestantId}/view.html"`;
    const matches = updatedHtml.split(from).length - 1;
    if (matches === 0) {
      const already = updatedHtml.split(to).length - 1;
      if (already !== 1)
        fail(
          `generation ${generationId} expected one gallery link for ${entry.contestantId}`,
        );
      continue;
    }
    if (matches !== 1)
      fail(
        `generation ${generationId} has ambiguous gallery links for ${entry.contestantId}`,
      );
    updatedHtml = updatedHtml.replace(from, to);
  }
  if (updatedHtml !== html) {
    writes.push({
      path: indexPath,
      relativePath: relativePosix(sitePath, indexPath),
      content: updatedHtml,
      exclusive: false,
    });
  }
  return { writes, viewers: viewerEntries.length };
}

export async function backfillPublishedViewers(
  options: BackfillViewersOptions,
): Promise<BackfillViewersResult> {
  if (!/^\d{4}$/u.test(options.seasonId)) fail("season ID must be four digits");
  const sitePath = options.sitePath;
  await directory(sitePath, "site root");
  const seasonsPath = join(sitePath, "seasons");
  await directory(seasonsPath, "seasons directory");
  const seasonPath = join(seasonsPath, options.seasonId);
  await directory(seasonPath, `season ${options.seasonId}`);
  const generations = (await readdir(seasonPath)).sort();
  if (generations.length === 0 || generations.some((id) => !GENERATION_ID.test(id))) {
    fail(`season ${options.seasonId} has an unexpected generation layout`);
  }
  const plans: PlannedWrite[] = [];
  let viewers = 0;
  for (const generationId of generations) {
    const generationPath = join(seasonPath, generationId);
    await directory(generationPath, `generation ${generationId}`);
    const plan = await planGeneration(
      sitePath,
      options.seasonId,
      generationId,
      generationPath,
    );
    plans.push(...plan.writes);
    viewers += plan.viewers;
  }
  const changedFiles = plans.map((plan) => plan.relativePath);
  if (options.dryRun !== true) {
    for (const plan of plans) {
      await mkdir(dirname(plan.path), { recursive: true });
      if (plan.exclusive) {
        await writeFile(plan.path, plan.content, { encoding: "utf8", flag: "wx" });
      } else {
        const temporaryPath = `${plan.path}.backfill-${process.pid}`;
        await writeFile(temporaryPath, plan.content, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, plan.path);
      }
    }
  }
  return {
    changedFiles,
    generations: generations.length,
    viewers,
    dryRun: options.dryRun === true,
  };
}
