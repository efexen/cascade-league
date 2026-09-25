import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import sharp from "sharp";

import {
  formatDimensionMeanLabels,
  buildArchivedSeasonDefinition,
  buildChallengePage,
  GALLERY_SOURCE_ARCHIVE_FILE,
  publicFailureMessage,
} from "../challenge/index.js";
import type { PageAward, PageEntry } from "../challenge/data.js";
import {
  loadGalleryPresentation,
  validateLeaderboardIntegrity,
} from "./presentation.js";
import {
  ChallengeConfigSchema,
  ContestantsConfigSchema,
  GallerySourceArchiveSchema,
  IdentitySchema,
  JudgesConfigSchema,
  LeaderboardSchema,
  ManifestSchema,
  RunSchema,
  SnapshotSchema,
  ValidationSchema,
  readJsonWithSchema,
  readYamlWithSchema,
  type GalleryStaticCopy,
  type Leaderboard,
} from "../schemas/index.js";
import { writeTextAtomically } from "../contestants/support.js";
import {
  renderStaticPage,
  type StaticPageRenderInput,
  type StaticPageRenderResult,
} from "../rendering/static-page.js";

const PublicMetadataEntrySchema = z
  .object({
    contestantId: z.string().min(1),
    displayName: z.string().min(1),
    rank: z.number().int().positive().nullable(),
    status: z.string().min(1),
  })
  .strict();

export const PublicMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    seasonId: z.string().regex(/^\d{4}$/u),
    generationId: z.string().regex(/^\d{4}$/u),
    generatedAt: z.string().datetime({ offset: false }).endsWith("Z"),
    sourceGenerationIdentity: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    stylesheetKind: z.enum(["champion", "fallback"]),
    championContestantId: z.string().min(1).nullable(),
    championDisplayName: z.string().min(1).nullable(),
    championReason: z.string().min(1),
    expectedJudgeCount: z.number().int().nonnegative(),
    entries: z.array(PublicMetadataEntrySchema),
  })
  .strict();

export function sourceGenerationIdentity(
  manifestBytes: Uint8Array,
  publicationSourceNonce: string,
): string {
  const manifest = ManifestSchema.parse(
    JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as unknown,
  );
  const stableIdentity = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    seasonId: manifest.seasonId,
    generationId: manifest.generationId,
    createdAt: manifest.createdAt,
    previousGenerationId: manifest.previousGenerationId,
    challengeVersion: manifest.challengeVersion,
    configHashes: manifest.configHashes,
    environment: manifest.environment,
    contestantIds: manifest.contestantIds,
    judgeIds: manifest.judgeIds,
  });
  return `sha256:${createHash("sha256")
    .update(stableIdentity)
    .update("\0")
    .update(publicationSourceNonce)
    .digest("hex")}`;
}

export interface GalleryRenderer {
  render(input: StaticPageRenderInput): Promise<StaticPageRenderResult>;
}

export interface BuildGalleryOptions {
  readonly repositoryRoot: string;
  readonly generationPath: string;
  readonly outputPath?: string;
  readonly leaderboard?: Leaderboard;
  readonly renderer?: GalleryRenderer;
}

export interface BuiltGallery {
  readonly generationPath: string;
  readonly publicPath: string;
  readonly championContestantId: string | null;
  readonly stylesheetKind: "champion" | "fallback";
  readonly screenshotPath: string;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function statusLabel(
  status: Leaderboard["entries"][number]["status"],
  labels: GalleryStaticCopy["statusLabels"],
): string {
  return labels[status];
}

function scoreLabel(score: number | null): string {
  return score === null ? "—" : score.toFixed(2);
}

function publicScreenshotName(index: number): string {
  return `screenshots/entry-${String(index + 1).padStart(3, "0")}.png`;
}

function publicFullScreenshotName(index: number): string {
  return `screenshots/entry-${String(index + 1).padStart(3, "0")}-full.png`;
}

function publicDesignPath(contestantId: string): string {
  return `designs/${contestantId}/index.html`;
}

function publicViewerPath(contestantId: string): string {
  return `designs/${contestantId}/view.html`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

interface ViewerEntry {
  readonly contestantId: string;
  readonly displayName: string;
  readonly rank: number | null;
  readonly statusLabel: string;
  readonly combinedScore: number | null;
  readonly screenshotPath: string;
}

function renderDesignViewer(
  seasonId: string,
  generationId: string,
  entry: ViewerEntry,
  entries: readonly ViewerEntry[],
): string {
  const index = entries.findIndex(
    (candidate) => candidate.contestantId === entry.contestantId,
  );
  const previous = entries[index - 1];
  const next = entries[index + 1];
  const label = escapeHtml(entry.displayName);
  const result = `Rank ${entry.rank === null ? "—" : String(entry.rank)} · ${scoreLabel(entry.combinedScore)} · ${escapeHtml(entry.statusLabel)}`;
  const contestantLinks = entries
    .map((candidate) => {
      const current = candidate.contestantId === entry.contestantId;
      return `<li><a href="../${escapeHtml(candidate.contestantId)}/view.html"${current ? ' aria-current="page"' : ""}>${escapeHtml(candidate.displayName)}${current ? " (current)" : ""}</a></li>`;
    })
    .join("\n          ");
  const previousLink =
    previous === undefined
      ? '<span aria-disabled="true">Previous design</span>'
      : `<a rel="prev" href="../${escapeHtml(previous.contestantId)}/view.html">Previous design: ${escapeHtml(previous.displayName)}</a>`;
  const nextLink =
    next === undefined
      ? '<span aria-disabled="true">Next design</span>'
      : `<a rel="next" href="../${escapeHtml(next.contestantId)}/view.html">Next design: ${escapeHtml(next.displayName)}</a>`;
  const screenshotFile = entry.screenshotPath.replace(/\.png$/u, "-full.png");
  const iframeTitle = `${entry.displayName} design, Season ${seasonId}, Generation ${generationId}`;

  return `<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'">
    <meta name="referrer" content="no-referrer">
    <title>${label} · Season ${seasonId}, Generation ${generationId}</title>
    <style>
      *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0}body{overflow:hidden;background:#11120f;color:#f1f2e9;font:14px/1.4 system-ui,sans-serif}.viewer{display:flex;flex-direction:column;width:100%;height:100vh;height:100dvh;min-height:0}.bar{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:.5rem 1.25rem;padding:.65rem 1rem;background:#11120f;border-bottom:1px solid #45483b}.identity{min-width:0}.eyebrow{margin:0;color:#c1c5b4;font-size:.75rem;letter-spacing:.04em}.identity h1{overflow-wrap:anywhere;margin:.1rem 0 0;font-size:1rem;line-height:1.25}.result{margin:.12rem 0 0;color:#dfff39;font-size:.8rem}.controls{display:flex;align-items:center;justify-content:flex-end;gap:.75rem}.controls a,.controls summary,.context a{color:#dfff39;text-underline-offset:.2em}.entry-nav{display:flex;gap:.75rem}.entry-nav span{color:#818575}.switcher{position:relative}.switcher summary{cursor:pointer;white-space:nowrap}.switcher ul{position:absolute;z-index:2;top:calc(100% + .5rem);right:0;width:min(24rem,calc(100vw - 2rem));max-height:min(60vh,28rem);overflow:auto;margin:0;padding:.5rem;background:#20221c;border:1px solid #636752;list-style:none}.switcher li+li{border-top:1px solid #45483b}.switcher li a{display:block;padding:.55rem .65rem;overflow-wrap:anywhere}.context{display:flex;align-items:center;gap:.8rem;padding:.3rem 1rem;background:#24261e;color:#d5d8c9;font-size:.75rem}.context p{margin:0}.gallery-link{flex:none}.design-frame{display:block;flex:1 1 auto;width:100%;min-height:0;border:0;background:#fff}@media(max-width:600px){.bar{grid-template-columns:minmax(0,1fr);gap:.55rem;padding:.55rem .75rem}.controls{justify-content:space-between;flex-wrap:wrap}.entry-nav{flex:1;justify-content:space-between;gap:.35rem}.controls a,.controls summary{font-size:.82rem}.context{align-items:flex-start;padding:.4rem .75rem}.design-frame{min-height:0}}
    </style>
  </head>
  <body>
    <main class="viewer">
      <header class="bar">
        <div class="identity">
          <p class="eyebrow">Season ${seasonId} · Generation ${generationId}</p>
          <h1>${label}</h1>
          <p class="result">Current generation result: ${result}</p>
        </div>
        <div class="controls">
          <nav class="entry-nav" aria-label="Contestant designs">${previousLink}${nextLink}</nav>
          <details class="switcher">
            <summary>Browse contestants</summary>
            <ul aria-label="All viewable contestants">
          ${contestantLinks}
            </ul>
          </details>
        </div>
      </header>
      <div class="context">
        <a class="gallery-link" href="../../index.html">Back to gallery</a>
        <p>The embedded design styles previous-generation standings. This bar identifies the current entry and result.</p>
        <a href="index.html">Raw design HTML</a>
        <a href="../../${escapeHtml(screenshotFile)}">Full-size screenshot</a>
      </div>
      <iframe class="design-frame" title="${escapeHtml(iframeTitle)}" src="index.html" sandbox="allow-same-origin"></iframe>
    </main>
  </body>
</html>
`;
}

async function writeDesignViewers(
  rootPath: string,
  seasonId: string,
  generationId: string,
  entries: readonly ViewerEntry[],
): Promise<void> {
  for (const entry of entries) {
    await writeTextAtomically(
      join(rootPath, publicViewerPath(entry.contestantId)),
      renderDesignViewer(seasonId, generationId, entry, entries),
    );
  }
}

async function assertRegularFile(path: string, description: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${description} must be a regular file`);
  }
}

async function assertPngScreenshot(
  path: string,
  description: string,
  expectedWidth?: number,
  minimumHeight?: number,
  maximumHeight?: number,
): Promise<void> {
  await assertRegularFile(path, description);
  const metadata = await sharp(path).metadata();
  const dimensionsInvalid =
    expectedWidth === undefined ||
    minimumHeight === undefined ||
    maximumHeight === undefined
      ? (metadata.width ?? 0) <= 0 || (metadata.height ?? 0) <= 0
      : metadata.width !== expectedWidth ||
        (metadata.height ?? 0) < minimumHeight ||
        (metadata.height ?? 0) > maximumHeight;
  if (metadata.format !== "png" || dimensionsInvalid) {
    throw new Error(
      expectedWidth === undefined ||
      minimumHeight === undefined ||
      maximumHeight === undefined
        ? `${description} must be a PNG with positive dimensions`
        : `${description} must be a ${String(expectedWidth)}px-wide PNG between ${String(minimumHeight)}px and ${String(maximumHeight)}px tall`,
    );
  }
}

async function copyScreenshot(
  sourcePath: string,
  destinationPath: string,
  description: string,
  expectedWidth: number,
  minimumHeight: number,
  maximumHeight: number,
): Promise<void> {
  await assertPngScreenshot(
    sourcePath,
    description,
    expectedWidth,
    minimumHeight,
    maximumHeight,
  );
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

async function copyFonts(sourceRoot: string, destinationRoot: string): Promise<void> {
  await mkdir(destinationRoot, { recursive: true });
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const lowerName = entry.name.toLowerCase();
    if (!lowerName.endsWith(".ttf") && !/^ofl-[a-z0-9.-]+\.txt$/u.test(lowerName)) {
      continue;
    }
    const sourcePath = join(sourceRoot, entry.name);
    await assertRegularFile(sourcePath, `challenge font asset ${entry.name}`);
    await copyFile(sourcePath, join(destinationRoot, entry.name));
  }
}

async function copyPngAssets(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  await mkdir(destinationRoot, { recursive: true });
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.name.toLowerCase().endsWith(".png")) continue;
    const sourcePath = join(sourceRoot, entry.name);
    await assertRegularFile(sourcePath, `challenge image ${entry.name}`);
    await copyFile(sourcePath, join(destinationRoot, entry.name));
  }
}

async function stagePublicDesign(
  generationPath: string,
  temporaryPath: string,
  contestantId: string,
): Promise<string> {
  const contestantRoot = join(generationPath, "contestants", contestantId);
  const validation = await readJsonWithSchema(
    join(contestantRoot, "validation.json"),
    ValidationSchema,
  );
  if (validation.status !== "valid" || validation.sanitisedSha256 === null) {
    throw new Error(`candidate ${contestantId} does not have validated sanitised CSS`);
  }
  const sanitisedPath = join(contestantRoot, "sanitised.css");
  await assertRegularFile(sanitisedPath, `candidate ${contestantId} sanitised.css`);
  const sanitisedCss = await readFile(sanitisedPath);
  if (sha256(sanitisedCss) !== validation.sanitisedSha256) {
    throw new Error(
      `candidate ${contestantId} sanitised.css failed its validation hash check`,
    );
  }

  const relativePath = publicDesignPath(contestantId);
  const destinationRoot = dirname(join(temporaryPath, relativePath));
  const challengeRoot = join(generationPath, "challenge");
  await mkdir(destinationRoot, { recursive: true });
  await copyFile(
    join(challengeRoot, "challenge.html"),
    join(temporaryPath, relativePath),
  );
  await writeBytesAtomically(join(destinationRoot, "submission.css"), sanitisedCss);
  await copyFonts(join(challengeRoot, "fonts"), join(destinationRoot, "fonts"));
  await copyPngAssets(
    join(challengeRoot, "thumbnails"),
    join(destinationRoot, "thumbnails"),
  );
  return publicViewerPath(contestantId);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeBytesAtomically(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const directoryStatus = await lstat(directory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw new Error(
      `generation challenge directory is not a real directory: ${directory}`,
    );
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name).split(sep).join("/");
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `generation challenge asset must not be a symlink: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(
        `generation challenge asset is not a regular file: ${relativePath}`,
      );
    }
  }
  return files.sort();
}

async function verifyGenerationSources(
  generationPath: string,
  manifest: z.infer<typeof ManifestSchema>,
): Promise<{
  readonly snapshot: z.infer<typeof SnapshotSchema>;
  readonly archive: z.infer<typeof GallerySourceArchiveSchema>;
  readonly challengeConfig: z.infer<typeof ChallengeConfigSchema>;
  readonly judgesConfig: z.infer<typeof JudgesConfigSchema>;
}> {
  const snapshot = await readJsonWithSchema(
    join(generationPath, "challenge/snapshot.json"),
    SnapshotSchema,
  );
  const challengeRoot = join(generationPath, "challenge");
  if (snapshot.resolvedHtmlPath !== "challenge/challenge.html") {
    throw new Error("snapshot resolved HTML path is not the generation challenge HTML");
  }
  const expectedAssets = Object.keys(snapshot.assetHashes).sort();
  const actualAssets = (await listFiles(challengeRoot)).filter(
    (path) => path !== "snapshot.json",
  );
  if (
    actualAssets.length !== expectedAssets.length ||
    actualAssets.some((path, index) => path !== expectedAssets[index])
  ) {
    throw new Error("generation challenge asset set changed");
  }
  for (const [relativePath, expectedHash] of Object.entries(snapshot.assetHashes)) {
    const assetPath = join(challengeRoot, relativePath);
    await assertRegularFile(assetPath, `generation challenge asset ${relativePath}`);
    const asset = await readFile(assetPath);
    if (sha256(asset) !== expectedHash) {
      throw new Error(
        `generation challenge asset ${relativePath} failed its snapshot hash check`,
      );
    }
  }
  const archivePath = join(challengeRoot, GALLERY_SOURCE_ARCHIVE_FILE);
  if (snapshot.assetHashes[GALLERY_SOURCE_ARCHIVE_FILE] === undefined) {
    throw new Error("snapshot does not hash the archived gallery source");
  }
  const archive = await readJsonWithSchema(archivePath, GallerySourceArchiveSchema);
  if (archive.sourceTemplate !== snapshot.sourceTemplate) {
    throw new Error(
      "archived gallery source template path does not match the snapshot",
    );
  }

  const configPaths: Record<
    keyof z.infer<typeof ManifestSchema>["configHashes"],
    string
  > = {
    challenge: "config/challenge.yaml",
    contestants: "config/contestants.yaml",
    judges: "config/judges.yaml",
  };
  let challengeConfig: z.infer<typeof ChallengeConfigSchema> | null = null;
  let judgesConfig: z.infer<typeof JudgesConfigSchema> | null = null;
  for (const [name, relativePath] of Object.entries(configPaths) as [
    keyof z.infer<typeof ManifestSchema>["configHashes"],
    string,
  ][]) {
    const configPath = join(generationPath, relativePath);
    await assertRegularFile(configPath, `generation ${relativePath}`);
    const configBytes = await readFile(configPath);
    if (sha256(configBytes) !== manifest.configHashes[name]) {
      throw new Error(`generation ${relativePath} failed its manifest hash check`);
    }
    if (name === "challenge") {
      challengeConfig = await readYamlWithSchema(configPath, ChallengeConfigSchema);
    } else if (name === "contestants") {
      await readYamlWithSchema(configPath, ContestantsConfigSchema);
    } else {
      judgesConfig = await readYamlWithSchema(configPath, JudgesConfigSchema);
    }
  }
  if (challengeConfig === null || judgesConfig === null) {
    throw new Error("generation config snapshots are incomplete");
  }
  if (!isDeepStrictEqual(archive.challengeConfig, challengeConfig)) {
    throw new Error(
      "archived challenge configuration differs from its config snapshot",
    );
  }
  for (const seedEntry of archive.seed.entries) {
    if (snapshot.assetHashes[seedEntry.screenshotPath] === undefined) {
      throw new Error(
        `archived seed screenshot is not a hashed generation asset: ${seedEntry.screenshotPath}`,
      );
    }
  }
  return { snapshot, archive, challengeConfig, judgesConfig };
}

function expectedCandidateStatus(input: {
  readonly run: z.infer<typeof RunSchema>;
  readonly validation: z.infer<typeof ValidationSchema>;
  readonly screenshotExists: boolean;
}): Leaderboard["entries"][number]["status"] {
  if (input.run.status === "timeout") return "timeout";
  if (input.validation.status === "render_failed") return "render_failed";
  if (
    input.run.status === "failed" ||
    input.run.status === "uncertain" ||
    input.run.status === "missing_submission"
  ) {
    return "execution_failed";
  }
  if (input.run.status !== "succeeded") return "execution_failed";
  if (input.validation.status === "invalid") return "invalid";
  return input.screenshotExists ? "valid" : "render_failed";
}

async function pathExists(path: string): Promise<boolean> {
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

async function verifyLeaderboardArtifacts(
  generationPath: string,
  manifest: z.infer<typeof ManifestSchema>,
  leaderboard: Leaderboard,
): Promise<void> {
  validateLeaderboardIntegrity(leaderboard);
  if (leaderboard.expectedJudgeCount !== manifest.judgeIds.length) {
    throw new Error("leaderboard expected judge count does not match the manifest");
  }
  const manifestContestantIds = new Set(manifest.contestantIds);
  const leaderboardContestantIds = leaderboard.entries.map(
    (entry) => entry.contestantId,
  );
  if (
    leaderboard.entries.length !== manifestContestantIds.size ||
    new Set(leaderboardContestantIds).size !== leaderboardContestantIds.length ||
    leaderboardContestantIds.some(
      (contestantId) => !manifestContestantIds.has(contestantId),
    )
  ) {
    throw new Error(
      "leaderboard contestant set does not match the generation manifest",
    );
  }

  for (const entry of leaderboard.entries) {
    const contestantPath = join(generationPath, "contestants", entry.contestantId);
    const identityPath = join(contestantPath, "identity.json");
    await assertRegularFile(identityPath, `identity for ${entry.contestantId}`);
    const identity = await readJsonWithSchema(identityPath, IdentitySchema);
    if (identity.contestantId !== entry.contestantId) {
      throw new Error(
        `identity contestantId does not match its leaderboard directory: ${entry.contestantId}`,
      );
    }
    if (
      identity.displayName !== entry.displayName ||
      identity.harness.name !== entry.harnessName ||
      identity.model.name !== entry.modelName
    ) {
      throw new Error(
        `leaderboard public identity does not match immutable identity for ${entry.contestantId}`,
      );
    }
    const run = await readJsonWithSchema(join(contestantPath, "run.json"), RunSchema);
    const validation = await readJsonWithSchema(
      join(contestantPath, "validation.json"),
      ValidationSchema,
    );
    const screenshotPath = join(contestantPath, "screenshot.png");
    const screenshotExists = await pathExists(screenshotPath);
    if (entry.completedJudgeCount !== entry.judgeScores.length) {
      throw new Error(
        `leaderboard judge score count does not match completed count for ${entry.contestantId}`,
      );
    }
    const judgeScoreIds = entry.judgeScores.map((score) => score.judgeId);
    if (new Set(judgeScoreIds).size !== judgeScoreIds.length) {
      throw new Error(
        `leaderboard contains duplicate judge scores for ${entry.contestantId}`,
      );
    }
    for (const judgeId of judgeScoreIds) {
      if (!manifest.judgeIds.includes(judgeId)) {
        throw new Error(`leaderboard contains an unknown judge: ${judgeId}`);
      }
    }
    const expectedStatus = expectedCandidateStatus({
      run,
      validation,
      screenshotExists,
    });
    const visuallyValid = expectedStatus === "valid";
    if (visuallyValid) {
      const expectedLeaderboardStatus =
        entry.completedJudgeCount < leaderboard.expectedJudgeCount
          ? "judge_incomplete"
          : "valid";
      if (entry.status !== expectedLeaderboardStatus) {
        throw new Error(
          `leaderboard status does not match the valid contestant artifact: ${entry.contestantId}`,
        );
      }
      if (entry.screenshotPath !== `contestants/${entry.contestantId}/screenshot.png`) {
        throw new Error(
          `leaderboard screenshot path does not match ${entry.contestantId}`,
        );
      }
      await assertPngScreenshot(
        screenshotPath,
        `candidate ${entry.contestantId} screenshot`,
      );
    } else {
      if (entry.status !== expectedStatus) {
        throw new Error(
          `leaderboard status does not match contestant artifact ${entry.contestantId}`,
        );
      }
      if (entry.screenshotPath !== null || screenshotExists) {
        throw new Error(
          `failed contestant ${entry.contestantId} has an unexpected screenshot artifact`,
        );
      }
    }
    if (entry.expectedJudgeCount !== leaderboard.expectedJudgeCount) {
      throw new Error(
        `leaderboard judge count does not match the generation for ${entry.contestantId}`,
      );
    }
  }
}

function championEntry(
  leaderboard: Leaderboard,
): Leaderboard["entries"][number] | null {
  return (
    leaderboard.entries.find(
      (entry) =>
        entry.rank === 1 &&
        (entry.status === "valid" || entry.status === "judge_incomplete") &&
        entry.combinedScore !== null &&
        entry.completedJudgeCount > 0 &&
        entry.screenshotPath !== null,
    ) ?? null
  );
}

async function chooseStylesheet(
  generationPath: string,
  leaderboard: Leaderboard,
): Promise<{
  readonly kind: "champion" | "fallback";
  readonly bytes: Buffer;
  readonly champion: Leaderboard["entries"][number] | null;
  readonly reason: string;
}> {
  const champion = championEntry(leaderboard);
  if (champion !== null) {
    const contestantRoot = join(generationPath, "contestants", champion.contestantId);
    const validation = await readJsonWithSchema(
      join(contestantRoot, "validation.json"),
      ValidationSchema,
    );
    if (validation.status !== "valid" || validation.submissionSha256 === null) {
      throw new Error("ranked champion does not have valid submission validation");
    }
    const submissionPath = join(contestantRoot, "submission.css");
    await assertRegularFile(submissionPath, "champion submission.css");
    const submission = await readFile(submissionPath);
    if (sha256(submission) !== validation.submissionSha256) {
      throw new Error("champion submission.css failed its validation hash check");
    }
    return {
      kind: "champion",
      bytes: submission,
      champion,
      reason: `${champion.displayName} is the highest-ranked candidate with a valid judge result.`,
    };
  }

  const fallbackPath = join(generationPath, "challenge/fallback.css");
  await assertRegularFile(fallbackPath, "fallback.css");
  const hasVisuallyValidCandidate = leaderboard.entries.some(
    (entry) =>
      (entry.status === "valid" || entry.status === "judge_incomplete") &&
      entry.screenshotPath !== null,
  );
  const reason = hasVisuallyValidCandidate
    ? "No valid judge result was available; the fallback stylesheet is shown."
    : "No eligible candidate remained rankable; the fallback stylesheet is shown.";
  return {
    kind: "fallback",
    bytes: await readFile(fallbackPath),
    champion: null,
    reason,
  };
}

function pageEntries(
  leaderboard: Leaderboard,
  judgeNames: ReadonlyMap<string, string>,
  operationalLabelsByContestant: ReadonlyMap<
    string,
    { readonly runtimeLabel: string; readonly estimatedCostLabel: string }
  >,
  screenshotPaths: readonly string[],
  fullDesignPaths: readonly (string | null)[],
  statusLabels: GalleryStaticCopy["statusLabels"],
): PageEntry[] {
  return leaderboard.entries.map((entry, index) => ({
    id: entry.contestantId,
    rank: entry.rank,
    displayName: entry.displayName,
    harnessName: entry.harnessName,
    modelName: entry.modelName,
    status: entry.status,
    statusLabel: statusLabel(entry.status, statusLabels),
    alt:
      entry.screenshotPath === null
        ? `No screenshot available for ${entry.displayName}`
        : `${entry.displayName} candidate screenshot`,
    screenshotPath: screenshotPaths[index]!,
    ...(fullDesignPaths[index] === null
      ? {}
      : {
          fullScreenshotPath: screenshotPaths[index]!.replace(/\.png$/u, "-full.png"),
          fullDesignPath: fullDesignPaths[index]!,
        }),
    combinedScoreLabel: scoreLabel(entry.combinedScore),
    originalityScoreLabel: scoreLabel(entry.originalityScore),
    completedJudgeCount: entry.completedJudgeCount,
    expectedJudgeCount: entry.expectedJudgeCount,
    runtimeLabel:
      operationalLabelsByContestant.get(entry.contestantId)?.runtimeLabel ?? "—",
    estimatedCostLabel:
      operationalLabelsByContestant.get(entry.contestantId)?.estimatedCostLabel ?? "—",
    dimensionMeanLabels: formatDimensionMeanLabels(entry.dimensionMeans),
    judgeScores: entry.judgeScores.map((score) => ({
      judgeId: score.judgeId,
      judgeDisplayName: judgeNames.get(score.judgeId) ?? score.judgeId,
      totalScore: score.totalScore,
      originalityScore: score.originalityScore,
      critique: score.critique,
      ...(score.strongestQuality === undefined
        ? {}
        : { strongestQuality: score.strongestQuality }),
      ...(score.primaryWeakness === undefined
        ? {}
        : { primaryWeakness: score.primaryWeakness }),
      ...(score.nextMove === undefined ? {} : { nextMove: score.nextMove }),
      ...(score.scores === undefined ? {} : { scores: score.scores }),
      ...(score.candidateRank === undefined
        ? {}
        : { candidateRank: score.candidateRank }),
    })),
    awards: entry.awards.map((award) => ({ label: award.label })),
    failure: publicFailureMessage(entry.status),
  }));
}

function pageAwards(
  leaderboard: Leaderboard,
  judgeNames: ReadonlyMap<string, string>,
): PageAward[] {
  return leaderboard.entries.flatMap((entry) =>
    entry.awards.map((award) => ({
      label: award.label,
      anonymousCandidateId: `public-entry-${entry.contestantId}`,
      winningDisplayName: entry.displayName,
      judgeId: award.judgeId,
      judgeDisplayName: judgeNames.get(award.judgeId) ?? award.judgeId,
      rationale: award.rationale,
    })),
  );
}

async function replacePublicDirectory(
  temporaryPath: string,
  publicPath: string,
): Promise<void> {
  let existing = false;
  try {
    const status = await lstat(publicPath);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error("public output path must be a real directory");
    }
    existing = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  if (!existing) {
    await rename(temporaryPath, publicPath);
    return;
  }

  const backupPath = `${publicPath}.previous-${randomBytes(8).toString("hex")}`;
  await rename(publicPath, backupPath);
  try {
    await rename(temporaryPath, publicPath);
  } catch (error) {
    await rename(backupPath, publicPath).catch(() => undefined);
    throw error;
  }
  await rm(backupPath, { recursive: true, force: true });
}

export async function buildGallery(
  options: BuildGalleryOptions,
): Promise<BuiltGallery> {
  // Kept in the public API for callers that pass repository context; completed
  // gallery builds deliberately never read source bytes from it.
  void options.repositoryRoot;
  const generationPath = resolve(options.generationPath);
  const manifestPath = join(generationPath, "manifest.json");
  const manifestBytes = await readFile(manifestPath);

  const manifest = ManifestSchema.parse(
    JSON.parse(manifestBytes.toString("utf8")) as unknown,
  );
  if (
    manifest.status !== "scored" &&
    manifest.status !== "gallery_complete" &&
    manifest.status !== "completed"
  ) {
    throw new Error("gallery requires a scored or completed generation");
  }
  const leaderboard = LeaderboardSchema.parse(
    options.leaderboard ??
      (await readJsonWithSchema(
        join(generationPath, "leaderboard.json"),
        LeaderboardSchema,
      )),
  );
  if (
    leaderboard.seasonId !== manifest.seasonId ||
    leaderboard.generationId !== manifest.generationId
  ) {
    throw new Error("leaderboard does not match the generation manifest");
  }
  await verifyLeaderboardArtifacts(generationPath, manifest, leaderboard);
  const { snapshot, archive, challengeConfig, judgesConfig } =
    await verifyGenerationSources(generationPath, manifest);
  const presentation = await loadGalleryPresentation({
    generationPath,
    manifest,
    leaderboard,
    judgesConfig,
  });
  const challengeRoot = join(generationPath, "challenge");
  const definition = buildArchivedSeasonDefinition({
    rootPath: challengeRoot,
    archive,
    starterCss: await readFile(join(challengeRoot, "starter.css"), "utf8"),
    fallbackCss: await readFile(join(challengeRoot, "fallback.css"), "utf8"),
  });
  const judgeNames = new Map(
    judgesConfig.judges.map((judge) => [judge.id, judge.displayName]),
  );
  const stylesheet = await chooseStylesheet(generationPath, leaderboard);
  const publicPath = resolve(options.outputPath ?? join(generationPath, "public"));
  const temporaryPath = join(
    dirname(publicPath),
    `.${basename(publicPath)}.build-${randomBytes(8).toString("hex")}`,
  );
  const screenshotPaths: string[] = [];
  const fullDesignPaths: Array<string | null> = [];
  try {
    await mkdir(dirname(publicPath), { recursive: true });
    await mkdir(join(temporaryPath, "screenshots"), { recursive: true });
    await copyFonts(
      join(generationPath, "challenge/fonts"),
      join(temporaryPath, "fonts"),
    );
    for (const [index, entry] of leaderboard.entries.entries()) {
      const publicRelativePath = publicScreenshotName(index);
      const publicScreenshotPath = join(temporaryPath, publicRelativePath);
      if (entry.screenshotPath !== null) {
        const expectedPath = `contestants/${entry.contestantId}/screenshot.png`;
        if (entry.screenshotPath !== expectedPath) {
          throw new Error(
            `candidate ${entry.contestantId} has an unsafe screenshot path`,
          );
        }
        const fullRelativePath = publicFullScreenshotName(index);
        const fullSourcePath = join(generationPath, entry.screenshotPath);
        await copyScreenshot(
          fullSourcePath,
          join(temporaryPath, fullRelativePath),
          `candidate ${entry.contestantId} full screenshot`,
          challengeConfig.viewport.width,
          challengeConfig.viewport.height,
          12_000,
        );
        const viewportSourcePath = join(
          generationPath,
          "contestants",
          entry.contestantId,
          "screenshot-viewport.png",
        );
        let previewSourcePath = viewportSourcePath;
        try {
          await lstat(viewportSourcePath);
        } catch (error) {
          const missing =
            error instanceof Error && "code" in error && error.code === "ENOENT";
          if (!missing || challengeConfig.viewport.width !== 1440) throw error;
          previewSourcePath = fullSourcePath;
        }
        await copyScreenshot(
          previewSourcePath,
          publicScreenshotPath,
          `candidate ${entry.contestantId} viewport screenshot`,
          challengeConfig.viewport.width,
          challengeConfig.viewport.height,
          challengeConfig.viewport.height,
        );
        fullDesignPaths.push(
          await stagePublicDesign(generationPath, temporaryPath, entry.contestantId),
        );
      } else {
        const seedEntry =
          definition.seed.entries[index % definition.seed.entries.length]!;
        await copyScreenshot(
          join(generationPath, "challenge", seedEntry.screenshotPath),
          publicScreenshotPath,
          `fallback screenshot for ${entry.contestantId}`,
          challengeConfig.viewport.width,
          challengeConfig.viewport.height,
          12_000,
        );
        fullDesignPaths.push(null);
      }
      screenshotPaths.push(publicRelativePath);
    }

    await writeDesignViewers(
      temporaryPath,
      manifest.seasonId,
      manifest.generationId,
      leaderboard.entries.flatMap((entry, index) =>
        fullDesignPaths[index] === null
          ? []
          : [
              {
                contestantId: entry.contestantId,
                displayName: entry.displayName,
                rank: entry.rank,
                statusLabel: statusLabel(
                  entry.status,
                  definition.staticCopy.statusLabels,
                ),
                combinedScore: entry.combinedScore,
                screenshotPath: screenshotPaths[index]!,
              },
            ],
      ),
    );

    const renderer =
      options.renderer ??
      new (class implements GalleryRenderer {
        public render(input: StaticPageRenderInput): Promise<StaticPageRenderResult> {
          return renderStaticPage(input);
        }
      })();
    const renderPublic = async (
      selectedStylesheet: typeof stylesheet,
    ): Promise<void> => {
      await writeBytesAtomically(
        join(temporaryPath, "champion.css"),
        selectedStylesheet.bytes,
      );
      const page = await buildChallengePage({
        definition,
        generationId: manifest.generationId,
        stylesheetPath: "champion.css",
        generatedAt: leaderboard.generatedAt,
        statusBadge:
          selectedStylesheet.champion === null
            ? `No champion · ${selectedStylesheet.reason}`
            : selectedStylesheet.kind === "fallback"
              ? `Fallback CSS used · ${selectedStylesheet.reason}`
              : `Champion selected · ${selectedStylesheet.champion.displayName}`,
        entries: pageEntries(
          leaderboard,
          judgeNames,
          presentation.operationalLabelsByContestant,
          screenshotPaths,
          fullDesignPaths,
          definition.staticCopy.statusLabels,
        ),
        judgeMatrix: presentation.judgeMatrix,
        awards: pageAwards(leaderboard, judgeNames),
      });
      const publicHtml = page.html;
      if (
        /<script\b/iu.test(publicHtml) ||
        /\b(?:src|href)=["'](?:https?:|\/\/)/iu.test(publicHtml)
      ) {
        throw new Error("public HTML contains a script or remote resource");
      }
      await writeTextAtomically(join(temporaryPath, "index.html"), publicHtml);
      await writeJson(
        join(temporaryPath, "metadata.json"),
        PublicMetadataSchema.parse({
          schemaVersion: 1,
          seasonId: manifest.seasonId,
          generationId: manifest.generationId,
          generatedAt: leaderboard.generatedAt,
          sourceGenerationIdentity: sourceGenerationIdentity(
            manifestBytes,
            snapshot.publicationSourceNonce,
          ),
          stylesheetKind: selectedStylesheet.kind,
          championContestantId: selectedStylesheet.champion?.contestantId ?? null,
          championDisplayName: selectedStylesheet.champion?.displayName ?? null,
          championReason: selectedStylesheet.reason,
          expectedJudgeCount: leaderboard.expectedJudgeCount,
          entries: leaderboard.entries.map((entry) => ({
            contestantId: entry.contestantId,
            displayName: entry.displayName,
            rank: entry.rank,
            status: entry.status,
          })),
        }),
      );
      await renderer.render({
        rootPath: temporaryPath,
        entryFile: "index.html",
        screenshotPath: join(temporaryPath, "gallery-screenshot.png"),
        viewportScreenshotPath: join(temporaryPath, "gallery-viewport.png"),
        challengeConfig,
      });
    };

    const selectedStylesheet = stylesheet;
    await renderPublic(selectedStylesheet);
    await replacePublicDirectory(temporaryPath, publicPath);
    return {
      generationPath,
      publicPath,
      championContestantId: selectedStylesheet.champion?.contestantId ?? null,
      stylesheetKind: selectedStylesheet.kind,
      screenshotPath: join(publicPath, "gallery-screenshot.png"),
    };
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
