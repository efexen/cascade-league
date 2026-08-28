import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch } from "node:process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";
import { promisify } from "node:util";

import { chromium } from "playwright";
import sharp from "sharp";

import {
  buildPreviousChallengePage,
  buildSeedChallengePage,
  GALLERY_SOURCE_ARCHIVE_FILE,
  loadSeasonDefinition,
  PREVIOUS_GENERATION_THUMBNAIL_SIZE,
  type ChallengePage,
  type SeasonDefinition,
} from "../challenge/index.js";
import {
  AnonymousMapSchema,
  ContestantsConfigSchema,
  GallerySourceArchiveSchema,
  GenerationIdSchema,
  IdentitySchema,
  JudgesConfigSchema,
  LeaderboardSchema,
  ManifestSchema,
  RunSchema,
  SnapshotSchema,
  SeasonIdSchema,
  UtcTimestampSchema,
  readYamlWithSchema,
  readJsonWithSchema,
  type ContestantConfig,
  type ContestantsConfig,
  type Leaderboard,
} from "../schemas/index.js";

const PlaywrightPackageSchema = z.object({ version: z.string().min(1) }).passthrough();

const execFileAsync = promisify(execFile);
const DEFAULT_CHROMIUM_VERSION = "not-installed";
const NOT_RECORDED_VERSION = "not-recorded";

export interface CreateGenerationOptions {
  readonly repositoryRoot: string;
  readonly generationsRoot?: string;
  readonly seasonId: string;
  readonly generationId?: string;
  readonly now?: string | Date;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface CreatedGeneration {
  readonly seasonId: string;
  readonly generationId: string;
  readonly generationPath: string;
  readonly anonymousCandidateIds: readonly string[];
}

function seasonDirectoryName(seasonId: string): string {
  return `season-${Number.parseInt(seasonId, 10).toString().padStart(3, "0")}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readPlaywrightVersion(repositoryRoot: string): Promise<string> {
  const packagePath = join(repositoryRoot, "node_modules/playwright/package.json");
  try {
    const packageJson = PlaywrightPackageSchema.parse(
      JSON.parse(await readFile(packagePath, "utf8")) as unknown,
    );
    return packageJson.version;
  } catch {
    return NOT_RECORDED_VERSION;
  }
}

async function readChromiumVersion(): Promise<string> {
  try {
    const executablePath = chromium.executablePath();
    const result = await execFileAsync(executablePath, ["--version"], {
      shell: false,
    });
    const version = `${result.stdout}\n${result.stderr}`.match(
      /\d+\.\d+\.\d+\.\d+/,
    )?.[0];
    return version ?? DEFAULT_CHROMIUM_VERSION;
  } catch {
    return DEFAULT_CHROMIUM_VERSION;
  }
}

function asTimestamp(value: string | Date | undefined): string {
  const timestamp =
    value instanceof Date ? value.toISOString() : (value ?? new Date().toISOString());
  return UtcTimestampSchema.parse(timestamp);
}

function posixPath(path: string): string {
  return path.split(sep).join("/");
}

function repositoryRelativePath(repositoryRoot: string, path: string): string {
  return posixPath(relative(repositoryRoot, path));
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

interface SnapshotInputSource {
  readonly provenancePath: string;
  readonly sourcePath: string;
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const directoryStatus = await lstat(directory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw new Error(
      `generation source directory must be a real directory: ${directory}`,
    );
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name);
    const sourcePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`generation source must not contain symlinks: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(sourcePath, relativePath)));
    } else if (entry.isFile()) {
      files.push(posixPath(relativePath));
    } else {
      throw new Error(
        `generation source must contain regular files only: ${relativePath}`,
      );
    }
  }
  return files.sort();
}

async function buildSnapshotInputHashes(input: {
  readonly repositoryRoot: string;
  readonly seasonRoot: string;
  readonly definition: SeasonDefinition;
  readonly challengeSourcePath: string;
  readonly contestantsSourcePath: string;
  readonly judgesSourcePath: string;
  readonly previousGenerationId: string | null;
  readonly previousGenerationPath: string | null;
  readonly previousLeaderboard: Leaderboard | null;
}): Promise<Record<string, string>> {
  const sources = new Map<string, string>();
  const addRepositorySource = (sourcePath: string): void => {
    sources.set(repositoryRelativePath(input.repositoryRoot, sourcePath), sourcePath);
  };

  addRepositorySource(input.challengeSourcePath);
  addRepositorySource(input.contestantsSourcePath);
  addRepositorySource(input.judgesSourcePath);
  addRepositorySource(join(input.seasonRoot, input.definition.config.template));
  addRepositorySource(join(input.seasonRoot, input.definition.config.starterCss));
  addRepositorySource(join(input.seasonRoot, input.definition.config.fallbackCss));
  addRepositorySource(join(input.seasonRoot, input.definition.config.seedData));

  for (const directory of [
    join(input.seasonRoot, "fonts"),
    join(input.seasonRoot, "seed/thumbnails"),
  ]) {
    for (const file of await listFiles(directory)) {
      addRepositorySource(join(directory, file));
    }
  }

  if (
    input.previousGenerationId !== null &&
    input.previousGenerationPath !== null &&
    input.previousLeaderboard !== null
  ) {
    const previousPrefix = posixPath(join("generations", input.previousGenerationId));
    sources.set(
      `${previousPrefix}/manifest.json`,
      join(input.previousGenerationPath, "manifest.json"),
    );
    sources.set(
      `${previousPrefix}/leaderboard.json`,
      join(input.previousGenerationPath, "leaderboard.json"),
    );
    for (const entry of input.previousLeaderboard.entries) {
      if (entry.screenshotPath !== null) {
        sources.set(
          posixPath(join(previousPrefix, entry.screenshotPath)),
          resolve(input.previousGenerationPath, entry.screenshotPath),
        );
      }
    }
  }

  const sortedSources: SnapshotInputSource[] = [...sources.entries()]
    .map(([provenancePath, sourcePath]) => ({ provenancePath, sourcePath }))
    .sort((left, right) =>
      left.provenancePath < right.provenancePath
        ? -1
        : left.provenancePath > right.provenancePath
          ? 1
          : 0,
    );
  return Object.fromEntries(
    await Promise.all(
      sortedSources.map(
        async ({ provenancePath, sourcePath }) =>
          [provenancePath, await sha256File(sourcePath)] as const,
      ),
    ),
  );
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  const sourceStatus = await lstat(source);
  if (sourceStatus.isSymbolicLink() || !sourceStatus.isDirectory()) {
    throw new Error(`generation source directory must be a real directory: ${source}`);
  }
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`generation source must not contain symlinks: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(
        `generation source must contain regular files only: ${entry.name}`,
      );
    }
  }
}

async function writePreviousGenerationThumbnail(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  await sharp(sourcePath)
    .resize({
      ...PREVIOUS_GENERATION_THUMBNAIL_SIZE,
      fit: "fill",
      kernel: "lanczos3",
    })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(destinationPath);
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

async function assertRegularPng(path: string): Promise<void> {
  const fileStatus = await lstat(path);
  if (fileStatus.isSymbolicLink()) {
    throw new Error(`previous screenshot must not be a symlink: ${path}`);
  }
  if (!fileStatus.isFile()) {
    throw new Error(`previous screenshot must be a regular file: ${path}`);
  }

  let format: string | undefined;
  try {
    format = (await sharp(path).metadata()).format;
  } catch (error) {
    throw new Error(`previous screenshot is not a readable PNG: ${path}`, {
      cause: error,
    });
  }
  if (format !== "png") {
    throw new Error(`previous screenshot must be a PNG: ${path}`);
  }
}

async function assertPreviousScreenshotArtifact(
  previousGenerationPath: string,
  contestantId: string,
  screenshotPath: string,
  sourcePath: string,
): Promise<void> {
  if (screenshotPath !== `contestants/${contestantId}/screenshot.png`) {
    throw new Error(
      "previous screenshot path must be contestants/<contestantId>/screenshot.png",
    );
  }

  const previousRoot = resolve(previousGenerationPath);
  const resolvedSourcePath = resolve(previousRoot, screenshotPath);
  if (!isContainedPath(previousRoot, resolvedSourcePath)) {
    throw new Error(
      "previous screenshot must be contained under the previous generation",
    );
  }
  if (resolve(sourcePath) !== resolvedSourcePath) {
    throw new Error(
      "previous screenshot source does not match its resolved artifact path",
    );
  }

  const rootStatus = await lstat(previousRoot);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error("previous generation must be a real directory");
  }

  let currentPath = previousRoot;
  for (const segment of relative(previousRoot, resolvedSourcePath).split(sep)) {
    currentPath = join(currentPath, segment);
    const segmentStatus = await lstat(currentPath);
    if (segmentStatus.isSymbolicLink()) {
      throw new Error(
        `previous screenshot path must not contain symlinks: ${currentPath}`,
      );
    }
    if (currentPath !== resolvedSourcePath && !segmentStatus.isDirectory()) {
      throw new Error(
        `previous screenshot path contains a non-directory: ${currentPath}`,
      );
    }
  }

  await assertRegularPng(resolvedSourcePath);
}

async function writeJsonAtomically<T>(
  path: string,
  schema: z.ZodType<T>,
  value: T,
): Promise<void> {
  const validated = schema.parse(value);
  const temporaryPath = `${path}.${secureRandomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function makeReadOnly(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(path);
      await chmod(path, 0o555);
    } else if (entry.isFile()) {
      await chmod(path, 0o444);
    }
  }
  await chmod(directory, 0o555);
}

async function makeWritable(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeWritable(path);
      await chmod(path, 0o755);
    } else if (entry.isFile()) {
      await chmod(path, 0o644);
    }
  }
  await chmod(directory, 0o755);
}

async function makeContentsReadOnly(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(path);
    } else if (entry.isFile()) {
      await chmod(path, 0o444);
    }
  }
}

async function allocateGenerationId(generationsRoot: string): Promise<string> {
  if (!(await pathExists(generationsRoot))) {
    return "0001";
  }
  const entries = await readdir(generationsRoot, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10));
  const next = (ids.length === 0 ? 0 : Math.max(...ids)) + 1;
  if (next > 9999) {
    throw new Error("no four-digit generation IDs remain");
  }
  return next.toString().padStart(4, "0");
}

function requiredHooksArePresent(html: string, selectors: readonly string[]): void {
  for (const selector of selectors) {
    const escaped = selector.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const present = selector.startsWith("#")
      ? new RegExp(`id=["']${escaped}["']`).test(html)
      : [...html.matchAll(/class=["']([^"']*)["']/g)].some((match) =>
          new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(match[1] ?? ""),
        );
    if (!present) {
      throw new Error(
        `resolved challenge HTML is missing required selector ${selector}`,
      );
    }
  }
}

function makeAnonymousCandidateId(randomBytes: (size: number) => Buffer): string {
  return `candidate-${randomBytes(6).toString("hex")}`;
}

function configuredContestantBudget(
  contestant: ContestantConfig,
  config: ContestantsConfig,
) {
  return (
    contestant.budget ?? {
      timeoutMs: config.defaults.timeoutMs,
      maximumTotalTokens: config.defaults.maximumTotalTokens,
    }
  );
}

async function copyContestantInputs(
  generationPath: string,
  generationId: string,
  contestant: ContestantConfig,
  anonymousCandidateId: string,
  challengeFiles: readonly string[],
  contestantsConfig: ContestantsConfig,
): Promise<void> {
  const contestantPath = join(generationPath, "contestants", contestant.id);
  const workspacePath = join(contestantPath, "workspace");
  await mkdir(workspacePath, { recursive: true });
  for (const relativePath of challengeFiles.filter(
    (file) => file !== "fallback.css" && file !== GALLERY_SOURCE_ARCHIVE_FILE,
  )) {
    const sourcePath = join(generationPath, "challenge", relativePath);
    const destinationPath = join(workspacePath, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }

  const identity = {
    schemaVersion: 1 as const,
    contestantId: contestant.id,
    anonymousCandidateId,
    displayName: contestant.displayName,
    harness: {
      name: contestant.harness.name,
      configuredVersion: contestant.harness.version ?? NOT_RECORDED_VERSION,
    },
    model: {
      provider: contestant.model.provider,
      name: contestant.model.name,
      configuredVersion: contestant.model.version,
      ...(contestant.model.family === undefined
        ? {}
        : { family: contestant.model.family }),
      ...(contestant.model.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: contestant.model.reasoningEffort }),
    },
  };
  await writeJsonAtomically(
    join(contestantPath, "identity.json"),
    IdentitySchema,
    identity,
  );

  const run = {
    schemaVersion: 1 as const,
    taskId: `${generationId}-contestant-${anonymousCandidateId}`,
    status: "pending" as const,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    exitCode: null,
    timedOut: false,
    attemptCount: 0,
    configuredBudget: configuredContestantBudget(contestant, contestantsConfig),
    usage: {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
      tokenLimitEnforced: false,
    },
    observedVersions: {
      harness: contestant.harness.version ?? NOT_RECORDED_VERSION,
      model: contestant.model.version,
    },
    stdoutLog: `logs/contestant-${anonymousCandidateId}.stdout.log`,
    stderrLog: `logs/contestant-${anonymousCandidateId}.stderr.log`,
    error: null,
  };
  await writeJsonAtomically(join(contestantPath, "run.json"), RunSchema, run);
  await makeContentsReadOnly(workspacePath);
}

export async function createGeneration(
  options: CreateGenerationOptions,
): Promise<CreatedGeneration> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const generationsRoot = resolve(
    options.generationsRoot ?? join(repositoryRoot, "generations"),
  );
  const seasonId = options.seasonId;
  SeasonIdSchema.parse(seasonId);

  const seasonRoot = join(repositoryRoot, "challenge", seasonDirectoryName(seasonId));
  const definition = await loadSeasonDefinition(seasonRoot);
  const contestantsSourcePath = join(repositoryRoot, "config/contestants.yaml");
  const judgesSourcePath = join(repositoryRoot, "config/judges.yaml");
  const challengeSourcePath = join(seasonRoot, "challenge.yaml");
  const [contestantsSource, judgesSource, challengeSource] = await Promise.all([
    readFile(contestantsSourcePath),
    readFile(judgesSourcePath),
    readFile(challengeSourcePath),
  ]);
  const [contestantsConfig, judgesConfig] = await Promise.all([
    readYamlWithSchema(contestantsSourcePath, ContestantsConfigSchema),
    readYamlWithSchema(judgesSourcePath, JudgesConfigSchema),
  ]);

  if (definition.config.seasonId !== seasonId) {
    throw new Error("requested seasonId does not match challenge configuration");
  }
  if (
    contestantsConfig.contestants.filter((contestant) => contestant.enabled).length < 2
  ) {
    throw new Error("Season 1 requires at least two enabled contestants");
  }
  if (
    contestantsConfig.contestants.filter((contestant) => contestant.enabled).length > 6
  ) {
    throw new Error("Season 1 supports at most six enabled contestants");
  }

  const generationId =
    options.generationId ?? (await allocateGenerationId(generationsRoot));
  GenerationIdSchema.parse(generationId);
  await mkdir(generationsRoot, { recursive: true });
  const generationPath = join(generationsRoot, generationId);
  if (await pathExists(generationPath)) {
    throw new Error(`generation ${generationId} already exists; refusing to reuse it`);
  }

  const temporaryGenerationPath = join(
    generationsRoot,
    `.${generationId}.creating-${secureRandomBytes(8).toString("hex")}`,
  );
  const timestamp = asTimestamp(options.now);
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const enabledContestants = contestantsConfig.contestants.filter(
    (contestant) => contestant.enabled,
  );
  const enabledJudges = judgesConfig.judges.filter((judge) => judge.enabled);
  const anonymousEntries = enabledContestants.map((contestant) => ({
    contestantId: contestant.id,
    anonymousCandidateId: makeAnonymousCandidateId(randomBytes),
  }));
  if (
    new Set(anonymousEntries.map((entry) => entry.anonymousCandidateId)).size !==
    anonymousEntries.length
  ) {
    throw new Error("cryptographic anonymous candidate IDs collided");
  }

  const numericGenerationId = Number.parseInt(generationId, 10);
  const previousGenerationId =
    numericGenerationId > 1
      ? (numericGenerationId - 1).toString().padStart(4, "0")
      : null;
  let page: ChallengePage;
  let previousScreenshotSources: readonly {
    readonly sourcePath: string;
    readonly destinationPath: string;
  }[] = [];
  let previousGenerationPath: string | null = null;
  let previousLeaderboard: Leaderboard | null = null;
  if (previousGenerationId === null) {
    page = await buildSeedChallengePage({
      definition,
      generationId,
      rosterSize: enabledContestants.length,
      stylesheetPath: "submission.css",
      generatedAt: timestamp,
    });
  } else {
    const currentPreviousGenerationPath = join(generationsRoot, previousGenerationId);
    previousGenerationPath = currentPreviousGenerationPath;
    if (!(await pathExists(currentPreviousGenerationPath))) {
      throw new Error(
        `previous generation ${previousGenerationId} is required before creating ${generationId}`,
      );
    }
    const previousManifestPath = join(currentPreviousGenerationPath, "manifest.json");
    const previousManifest = await readJsonWithSchema(
      previousManifestPath,
      ManifestSchema,
    );
    if (
      previousManifest.seasonId !== seasonId ||
      previousManifest.generationId !== previousGenerationId
    ) {
      throw new Error(
        "previous manifest does not match the requested season or generation",
      );
    }
    if (
      previousManifest.status !== "completed" ||
      previousManifest.completedAt === null
    ) {
      throw new Error(`previous generation ${previousGenerationId} is not completed`);
    }
    const currentContestantIds = enabledContestants.map((contestant) => contestant.id);
    if (
      currentContestantIds.length !== previousManifest.contestantIds.length ||
      currentContestantIds.some(
        (contestantId, index) => contestantId !== previousManifest.contestantIds[index],
      )
    ) {
      throw new Error(
        "enabled contestant roster must exactly match the previous manifest roster",
      );
    }
    const currentPreviousLeaderboardPath = join(
      currentPreviousGenerationPath,
      "leaderboard.json",
    );
    const currentPreviousLeaderboard = await readJsonWithSchema(
      currentPreviousLeaderboardPath,
      LeaderboardSchema,
    );
    previousLeaderboard = currentPreviousLeaderboard;
    const previousManifestContestantIds = new Set(previousManifest.contestantIds);
    if (
      currentPreviousLeaderboard.seasonId !== seasonId ||
      currentPreviousLeaderboard.generationId !== previousGenerationId ||
      currentPreviousLeaderboard.entries.length !==
        previousManifestContestantIds.size ||
      currentPreviousLeaderboard.entries.some(
        (entry) => !previousManifestContestantIds.has(entry.contestantId),
      )
    ) {
      throw new Error(
        "previous leaderboard contestant roster does not match the previous manifest",
      );
    }
    const previousPage = await buildPreviousChallengePage({
      definition,
      generationId,
      stylesheetPath: "submission.css",
      generatedAt: timestamp,
      leaderboard: currentPreviousLeaderboard,
      previousGenerationPath: currentPreviousGenerationPath,
    });
    page = previousPage;
    previousScreenshotSources = previousPage.screenshotSources;
    await Promise.all(
      previousScreenshotSources.map(async (source, index) => {
        const entry = currentPreviousLeaderboard.entries[index];
        if (entry === undefined) {
          throw new Error("previous screenshot source has no leaderboard entry");
        }
        if (entry.screenshotPath === null) {
          await assertRegularPng(source.sourcePath);
        } else {
          await assertPreviousScreenshotArtifact(
            currentPreviousGenerationPath,
            entry.contestantId,
            entry.screenshotPath,
            source.sourcePath,
          );
        }
      }),
    );
  }

  try {
    await mkdir(temporaryGenerationPath, { recursive: true });
    await mkdir(join(temporaryGenerationPath, "config"), { recursive: true });
    await mkdir(join(temporaryGenerationPath, "challenge"), { recursive: true });
    await mkdir(join(temporaryGenerationPath, "contestants"), { recursive: true });
    await mkdir(join(temporaryGenerationPath, "judging"), { recursive: true });
    await mkdir(join(temporaryGenerationPath, "logs"), { recursive: true });

    await Promise.all([
      copyFile(
        challengeSourcePath,
        join(temporaryGenerationPath, "config/challenge.yaml"),
      ),
      copyFile(
        contestantsSourcePath,
        join(temporaryGenerationPath, "config/contestants.yaml"),
      ),
      copyFile(judgesSourcePath, join(temporaryGenerationPath, "config/judges.yaml")),
    ]);

    requiredHooksArePresent(page.html, definition.config.requiredSelectors);
    await writeFile(
      join(temporaryGenerationPath, "challenge/challenge.html"),
      page.html,
      "utf8",
    );
    await copyFile(
      join(seasonRoot, definition.config.starterCss),
      join(temporaryGenerationPath, "challenge/starter.css"),
    );
    await copyFile(
      join(seasonRoot, definition.config.fallbackCss),
      join(temporaryGenerationPath, "challenge/fallback.css"),
    );
    await copyDirectory(
      join(seasonRoot, "fonts"),
      join(temporaryGenerationPath, "challenge/fonts"),
    );
    await copyDirectory(
      join(seasonRoot, "seed/thumbnails"),
      join(temporaryGenerationPath, "challenge/thumbnails"),
    );
    for (const source of previousScreenshotSources) {
      const destinationPath = join(
        temporaryGenerationPath,
        "challenge",
        source.destinationPath,
      );
      await mkdir(dirname(destinationPath), { recursive: true });
      await writePreviousGenerationThumbnail(source.sourcePath, destinationPath);
    }

    await writeJsonAtomically(
      join(temporaryGenerationPath, "challenge", GALLERY_SOURCE_ARCHIVE_FILE),
      GallerySourceArchiveSchema,
      {
        schemaVersion: 1,
        sourceTemplate: repositoryRelativePath(
          repositoryRoot,
          join(seasonRoot, definition.config.template),
        ),
        challengeConfig: definition.config,
        template: definition.template,
        staticCopy: definition.staticCopy,
        seed: definition.seed,
      },
    );

    const challengeFiles = await listFiles(join(temporaryGenerationPath, "challenge"));
    const assetHashes = Object.fromEntries(
      await Promise.all(
        challengeFiles.map(
          async (file) =>
            [
              file,
              await sha256File(join(temporaryGenerationPath, "challenge", file)),
            ] as const,
        ),
      ),
    );
    const inputHashes = await buildSnapshotInputHashes({
      repositoryRoot,
      seasonRoot,
      definition,
      challengeSourcePath,
      contestantsSourcePath,
      judgesSourcePath,
      previousGenerationId,
      previousGenerationPath,
      previousLeaderboard,
    });
    const snapshot = {
      schemaVersion: 1 as const,
      sourceTemplate: repositoryRelativePath(
        repositoryRoot,
        join(seasonRoot, definition.config.template),
      ),
      dataSource:
        previousGenerationId === null
          ? {
              kind: "seed" as const,
              generationId: null,
              path: repositoryRelativePath(
                repositoryRoot,
                join(seasonRoot, definition.config.seedData),
              ),
            }
          : {
              kind: "previous_generation" as const,
              generationId: previousGenerationId,
              path: posixPath(
                join("generations", previousGenerationId, "leaderboard.json"),
              ),
            },
      resolvedHtmlPath: "challenge/challenge.html",
      resolvedHtmlSha256: await sha256File(
        join(temporaryGenerationPath, "challenge/challenge.html"),
      ),
      inputHashes,
      assetHashes,
    };
    await writeJsonAtomically(
      join(temporaryGenerationPath, "challenge/snapshot.json"),
      SnapshotSchema,
      snapshot,
    );

    for (const [index, contestant] of enabledContestants.entries()) {
      const anonymousCandidateId = anonymousEntries[index]?.anonymousCandidateId;
      if (anonymousCandidateId === undefined) {
        throw new Error(`missing anonymous candidate ID for ${contestant.id}`);
      }
      await copyContestantInputs(
        temporaryGenerationPath,
        generationId,
        contestant,
        anonymousCandidateId,
        challengeFiles,
        contestantsConfig,
      );
    }

    await writeJsonAtomically(
      join(temporaryGenerationPath, "judging/anonymous-map.json"),
      AnonymousMapSchema,
      {
        schemaVersion: 1,
        generationId,
        entries: anonymousEntries,
      },
    );

    const manifest = {
      schemaVersion: 1 as const,
      seasonId,
      generationId,
      status: "created" as const,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      previousGenerationId,
      challengeVersion: definition.config.challengeVersion,
      configHashes: {
        challenge: createHash("sha256").update(challengeSource).digest("hex"),
        contestants: createHash("sha256").update(contestantsSource).digest("hex"),
        judges: createHash("sha256").update(judgesSource).digest("hex"),
      },
      environment: {
        os: process.platform === "darwin" ? "macOS" : process.platform,
        architecture: arch,
        nodeVersion: process.version,
        playwrightVersion: await readPlaywrightVersion(repositoryRoot),
        chromiumVersion: await readChromiumVersion(),
      },
      contestantIds: enabledContestants.map((contestant) => contestant.id),
      judgeIds: enabledJudges.map((judge) => judge.id),
      errors: [],
    };
    await writeJsonAtomically(
      join(temporaryGenerationPath, "manifest.json"),
      ManifestSchema,
      manifest,
    );

    await makeReadOnly(join(temporaryGenerationPath, "challenge"));
    await rename(temporaryGenerationPath, generationPath);
  } catch (error) {
    await makeWritable(temporaryGenerationPath).catch(() => undefined);
    await rm(temporaryGenerationPath, { recursive: true, force: true });
    throw error;
  }

  return {
    seasonId,
    generationId,
    generationPath,
    anonymousCandidateIds: anonymousEntries.map((entry) => entry.anonymousCandidateId),
  };
}
