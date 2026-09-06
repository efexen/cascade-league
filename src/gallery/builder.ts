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
import { GALLERY_LAYOUT_CSS } from "./layout.js";

const GALLERY_LAYOUT_STYLESHEET_LINK =
  '    <link rel="stylesheet" href="gallery-layout.css">';

function attachGalleryLayoutStylesheet(html: string): string {
  const closingHead = "  </head>";
  const firstIndex = html.indexOf(closingHead);
  if (firstIndex < 0 || html.indexOf(closingHead, firstIndex + 1) >= 0) {
    throw new Error("public HTML must contain exactly one closing head tag");
  }
  return html.replace(closingHead, `${GALLERY_LAYOUT_STYLESHEET_LINK}\n${closingHead}`);
}
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
  GalleryContentVisibilityError,
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
    stylesheetKind: z.enum(["champion", "fallback"]),
    championContestantId: z.string().min(1).nullable(),
    championDisplayName: z.string().min(1).nullable(),
    championReason: z.string().min(1),
    expectedJudgeCount: z.number().int().nonnegative(),
    entries: z.array(PublicMetadataEntrySchema),
  })
  .strict();

export interface GalleryRenderer {
  render(input: StaticPageRenderInput): Promise<StaticPageRenderResult>;
}

export interface BuildGalleryOptions {
  readonly repositoryRoot: string;
  readonly generationPath: string;
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
    if (!entry.name.toLowerCase().endsWith(".ttf")) continue;
    const sourcePath = join(sourceRoot, entry.name);
    await assertRegularFile(sourcePath, `challenge font ${entry.name}`);
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
  return relativePath;
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
          // Historical archived templates used this field as their action URL.
          fullScreenshotPath: fullDesignPaths[index]!,
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
  const manifest = await readJsonWithSchema(
    join(generationPath, "manifest.json"),
    ManifestSchema,
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
  const { archive, challengeConfig, judgesConfig } = await verifyGenerationSources(
    generationPath,
    manifest,
  );
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
  const fallbackBytes = await readFile(join(challengeRoot, "fallback.css"));
  const publicPath = join(generationPath, "public");
  const temporaryPath = join(
    generationPath,
    `.${basename(publicPath)}.build-${randomBytes(8).toString("hex")}`,
  );
  const screenshotPaths: string[] = [];
  const fullDesignPaths: Array<string | null> = [];
  try {
    await mkdir(join(temporaryPath, "screenshots"), { recursive: true });
    await copyFonts(
      join(generationPath, "challenge/fonts"),
      join(temporaryPath, "fonts"),
    );
    await writeTextAtomically(
      join(temporaryPath, "gallery-layout.css"),
      GALLERY_LAYOUT_CSS,
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
              ? "Rank 1 retained · fallback CSS used because champion content was hidden"
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
      const publicHtml = attachGalleryLayoutStylesheet(page.html);
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
        verifyGalleryContent: true,
      });
    };

    let selectedStylesheet = stylesheet;
    try {
      await renderPublic(selectedStylesheet);
    } catch (error) {
      if (
        selectedStylesheet.kind !== "champion" ||
        !(error instanceof GalleryContentVisibilityError)
      ) {
        throw error;
      }
      selectedStylesheet = {
        kind: "fallback",
        bytes: fallbackBytes,
        champion: selectedStylesheet.champion,
        reason: `${selectedStylesheet.champion?.displayName ?? "The rank-1 candidate"} remains the numeric rank-1 champion, but its CSS could not safely present required public content; the archived fallback stylesheet is used.`,
      };
      await rm(join(temporaryPath, "gallery-screenshot.png"), { force: true });
      await rm(join(temporaryPath, "gallery-viewport.png"), { force: true });
      await renderPublic(selectedStylesheet);
    }
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
