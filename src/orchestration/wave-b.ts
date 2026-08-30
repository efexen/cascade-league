import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { allocateGenerationId, createGeneration } from "../artifacts/generation.js";
import { resolveProfile } from "../config/profiles.js";
import {
  buildContestantGenerationOnePrompt,
  buildJudgeAwardsPrompt,
  buildJudgeCandidatePrompt,
} from "../prompts/index.js";
import {
  CandidateJudgmentSchema,
  ChallengeConfigSchema,
  ContactSheetOrderSchema,
  ContestantsConfigSchema,
  createGenerationAwardsSchema,
  GenerationAwardsSchema,
  JudgeAssessmentOrderSchema,
  JudgeSummarySchema,
  JudgeTaskTimingsSchema,
  JudgesConfigSchema,
  AnonymousMapSchema,
  ManifestSchema,
  ProfileJsonSchema,
  RunSchema,
  RunPlanSchema,
  SnapshotSchema,
  TaskStateSchema,
  TaskStateStatusSchema,
  ValidationSchema,
  readJsonWithSchema,
  readYamlWithSchema,
  UtcTimestampSchema,
  type ChallengeConfig,
  type ContestantConfig,
  type ContestantsConfig,
  type JudgeConfig,
  type JudgesConfig,
  type Manifest,
  type ProfileJson,
  type Run,
  type Snapshot,
  type TaskState,
  type Validation,
} from "../schemas/index.js";
import {
  CommandContestantAdapter,
  FixtureContestantAdapter,
  type ContestantAdapter,
  type ContestantRunResult,
} from "../contestants/index.js";
import {
  CommandJudgeAdapter,
  FixtureJudgeAdapter,
  type JudgeAdapter,
  type JudgeAwardsResult,
  type JudgeCandidateResult,
  type JudgeAwardsInput,
} from "../judging/index.js";
import {
  renderCandidate,
  type CandidateRenderResult,
  type CandidateRendererOptions,
} from "../rendering/index.js";
import { GALLERY_SOURCE_ARCHIVE_FILE } from "../challenge/index.js";
import { validateSubmission } from "../validation/index.js";
import {
  buildAnonymousContactSheet,
  type AnonymousContactSheetResult,
} from "../judging/index.js";
import {
  regularFileExists,
  DEFAULT_USAGE_LIMIT_BYTES,
  readRegularFileAtMost,
  writeTextAtomically,
  NOT_RECORDED_VERSION,
} from "../contestants/support.js";
import { ResourceAwareScheduler, type SchedulerTime } from "./resource-scheduler.js";

export interface WaveBRunOptions {
  readonly repositoryRoot: string;
  readonly seasonId?: string;
  readonly profileId?: string;
  readonly generationPath?: string;
  readonly generationsRoot?: string;
  readonly generationId?: string;
  readonly now?: string | Date;
  readonly clock?: () => Date;
  /** Monotonic scheduler clock injection for deterministic orchestration tests. */
  readonly schedulerTime?: SchedulerTime;
  readonly randomBytes?: (size: number) => Buffer;
  readonly contestantAdapters?: ReadonlyMap<string, ContestantAdapter>;
  readonly judgeAdapters?: ReadonlyMap<string, JudgeAdapter>;
  readonly contestantAdapterFactory?: (
    contestant: ContestantConfig,
  ) => ContestantAdapter;
  readonly judgeAdapterFactory?: (judge: JudgeConfig) => JudgeAdapter;
  readonly renderer?: {
    render(
      input: Parameters<typeof renderCandidate>[0],
    ): Promise<CandidateRenderResult>;
  };
  readonly rendererOptions?: CandidateRendererOptions;
  readonly contactSheetBuilder?: (
    input: Parameters<typeof buildAnonymousContactSheet>[0],
  ) => Promise<AnonymousContactSheetResult>;
  /** Enable persisted task-state replay for resume-generation. */
  readonly resumable?: boolean;
  /**
   * Explicit operator grant that this run may make external model calls
   * through command adapters. It is never persisted; every run that still has
   * callable command tasks must receive it again.
   */
  readonly allowModelCalls?: boolean;
  readonly acceptPromptOnlyOneShot?: boolean;
  readonly afterTask?: (task: WaveBTask) => void | Promise<void>;
  readonly onProgress?: (message: string) => void;
}

export interface WaveBTask {
  readonly role: "contestant" | "render" | "judge" | "awards";
  readonly targetId: string;
  readonly taskId: string;
}

export class WaveBInterruptionError extends Error {
  public constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "WaveBInterruptionError";
  }
}

export interface WaveBContestantResult {
  readonly contestantId: string;
  readonly anonymousCandidateId: string;
  readonly path: string;
  readonly run: Run;
  readonly validation: Validation;
  readonly screenshotPath: string | null;
  readonly integrityFailed: boolean;
  readonly canonicalIntegrityFailed: boolean;
}

export interface WaveBJudgeCandidateResult {
  readonly anonymousCandidateId: string;
  readonly result: JudgeCandidateResult;
  readonly durablePath: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

interface WaveBTaskTiming {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface WaveBJudgeResult {
  readonly judgeId: string;
  readonly path: string;
  readonly contactSheet: AnonymousContactSheetResult | null;
  readonly assessmentOrder: readonly string[];
  readonly assessmentOrderPath: string | null;
  readonly candidates: readonly WaveBJudgeCandidateResult[];
  readonly awards: JudgeAwardsResult | null;
  readonly awardsTiming: WaveBTaskTiming | null;
  readonly failure: string | null;
}

export interface WaveBRunResult {
  readonly generationPath: string;
  readonly generationId: string;
  readonly contestants: readonly WaveBContestantResult[];
  readonly judges: readonly WaveBJudgeResult[];
}

interface AnonymousCandidateIdentity {
  readonly anonymousCandidateId: string;
}

function anonymousCandidateIds(
  candidates: readonly AnonymousCandidateIdentity[],
): string[] {
  return candidates.map((candidate) => candidate.anonymousCandidateId);
}

function isRenderableCandidate(
  candidate: Pick<WaveBContestantResult, "run" | "validation" | "screenshotPath">,
): boolean {
  return (
    candidate.run.status === "succeeded" &&
    candidate.validation.status === "valid" &&
    candidate.screenshotPath !== null
  );
}

function renderableCandidates(
  candidates: readonly WaveBContestantResult[],
): WaveBContestantResult[] {
  return candidates.filter(isRenderableCandidate);
}

function successfulJudgmentResults(
  candidates: readonly WaveBJudgeCandidateResult[],
): WaveBJudgeCandidateResult[] {
  return candidates.filter(
    (candidate) =>
      candidate.result.status === "succeeded" && candidate.result.judgment !== null,
  );
}

function timestamp(value: string | Date | undefined): string {
  const candidate =
    value instanceof Date ? value.toISOString() : (value ?? new Date().toISOString());
  return UtcTimestampSchema.parse(candidate);
}

interface CanonicalGenerationState {
  readonly generationPath: string;
  readonly repositoryRoot: string;
  readonly snapshot: Snapshot;
  readonly snapshotHash: string;
  readonly configHashes: Manifest["configHashes"];
  readonly profile: ProfileJson;
  readonly legacyPhase1: boolean;
}

const MAX_INTEGRITY_FILE_BYTES = 64 * 1024 * 1024;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const file = await readRegularFileAtMost(path, MAX_INTEGRITY_FILE_BYTES);
  if (file.kind === "missing") throw new Error(`ENOENT: ${path}`);
  if (file.kind === "invalid")
    throw new Error(`integrity input is not a regular file: ${path}`);
  if (file.kind === "too_large") {
    throw new Error(
      `integrity input exceeds the ${MAX_INTEGRITY_FILE_BYTES}-byte limit: ${path}`,
    );
  }
  return sha256(file.bytes);
}

async function listRegularFiles(rootPath: string, prefix = ""): Promise<string[]> {
  const status = await lstat(rootPath);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`integrity input directory is not a real directory: ${rootPath}`);
  }
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name).split(sep).join("/");
    const entryPath = join(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`integrity input must not be a symlink: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(entryPath, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`integrity input is not a regular file: ${relativePath}`);
    }
  }
  return files.sort();
}

async function makeWorkspaceRemovable(path: string): Promise<void> {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (status.isSymbolicLink()) {
    await rm(path, { force: true });
    return;
  }
  if (status.isDirectory()) {
    await chmod(path, 0o755);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      await makeWorkspaceRemovable(join(path, entry.name));
    }
    await chmod(path, 0o755);
  } else {
    await chmod(path, 0o644);
  }
}

async function removeWorkspace(path: string): Promise<void> {
  await makeWorkspaceRemovable(path).catch(() => undefined);
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

async function verifyRegularFileHash(
  path: string,
  expectedHash: string,
  description: string,
  containingRoot?: string,
): Promise<void> {
  if (containingRoot !== undefined) {
    const rootPath = resolve(containingRoot);
    const candidatePath = resolve(path);
    const relativePath = relative(rootPath, candidatePath);
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error(`${description} is outside its trusted directory`);
    }
    const rootStatus = await lstat(rootPath);
    if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
      throw new Error(`${description} trusted directory is not real`);
    }
    let currentPath = rootPath;
    const segments = relativePath.split(sep);
    for (const [index, segment] of segments.entries()) {
      currentPath = join(currentPath, segment);
      const segmentStatus = await lstat(currentPath);
      if (segmentStatus.isSymbolicLink()) {
        throw new Error(`${description} path contains a symlink`);
      }
      if (index < segments.length - 1 && !segmentStatus.isDirectory()) {
        throw new Error(`${description} path contains a non-directory`);
      }
    }
  }
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${description} is not a regular file`);
  }
  const actualHash = await sha256File(path);
  if (actualHash !== expectedHash) {
    throw new Error(`${description} failed its canonical hash check`);
  }
}

async function loadCanonicalGenerationState(
  generationPath: string,
  repositoryRoot: string,
  configHashes: Manifest["configHashes"],
): Promise<CanonicalGenerationState> {
  const snapshotPath = join(generationPath, "challenge/snapshot.json");
  const snapshot = await readJsonWithSchema(snapshotPath, SnapshotSchema);
  let profile: ProfileJson;
  let legacyPhase1 = false;
  try {
    profile = await readJsonWithSchema(
      join(generationPath, "config/profile.json"),
      ProfileJsonSchema,
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    // Phase 1 generations predate named profiles. Their source config paths
    // were the repository-root config files, and their immutable generation
    // copies remain the canonical bytes after those sources moved in Phase 2.
    legacyPhase1 = true;
    profile = ProfileJsonSchema.parse({
      schemaVersion: 1,
      profileId: "legacy.phase1",
      sourcePaths: {
        contestants: "config/contestants.yaml",
        judges: "config/judges.yaml",
      },
    });
  }
  return {
    generationPath,
    repositoryRoot,
    snapshot,
    snapshotHash: await sha256File(snapshotPath),
    configHashes,
    profile,
    legacyPhase1,
  };
}

async function verifyCanonicalGenerationState(
  state: CanonicalGenerationState,
): Promise<void> {
  const challengeRoot = join(state.generationPath, "challenge");
  await verifyRegularFileHash(
    join(challengeRoot, "snapshot.json"),
    state.snapshotHash,
    "canonical snapshot",
    state.generationPath,
  );
  const expectedAssets = Object.keys(state.snapshot.assetHashes).sort();
  const actualAssets = await listRegularFiles(challengeRoot);
  const actualWithoutSnapshot = actualAssets.filter((path) => path !== "snapshot.json");
  if (
    actualWithoutSnapshot.length !== expectedAssets.length ||
    actualWithoutSnapshot.some((path, index) => path !== expectedAssets[index])
  ) {
    throw new Error("canonical challenge asset set changed");
  }
  for (const [relativePath, expectedHash] of Object.entries(
    state.snapshot.assetHashes,
  )) {
    await verifyRegularFileHash(
      join(challengeRoot, relativePath),
      expectedHash,
      `canonical challenge asset ${relativePath}`,
      challengeRoot,
    );
  }
  await verifyRegularFileHash(
    join(challengeRoot, "challenge.html"),
    state.snapshot.resolvedHtmlSha256,
    "canonical challenge HTML",
    challengeRoot,
  );
  const configFiles: Record<keyof Manifest["configHashes"], string> = {
    challenge: "config/challenge.yaml",
    contestants: "config/contestants.yaml",
    judges: "config/judges.yaml",
  };
  const sourceConfigFiles: Record<keyof Manifest["configHashes"], string> = {
    challenge: join(dirname(state.snapshot.sourceTemplate), "challenge.yaml")
      .split(sep)
      .join("/"),
    contestants: state.profile.sourcePaths.contestants,
    judges: state.profile.sourcePaths.judges,
  };
  for (const [name, relativePath] of Object.entries(configFiles) as [
    keyof Manifest["configHashes"],
    string,
  ][]) {
    const sourceRelativePath = sourceConfigFiles[name];
    const expectedHash = state.snapshot.inputHashes[sourceRelativePath];
    if (expectedHash === undefined) {
      throw new Error(`snapshot is missing the source hash for ${sourceRelativePath}`);
    }
    if (state.configHashes[name] !== expectedHash) {
      throw new Error(
        `manifest hash for ${relativePath} differs from the canonical snapshot`,
      );
    }
    await verifyRegularFileHash(
      join(state.generationPath, relativePath),
      expectedHash,
      `generation ${relativePath}`,
      state.generationPath,
    );
  }
  for (const [provenancePath, expectedHash] of Object.entries(
    state.snapshot.inputHashes,
  )) {
    // `config/profile.json` and `run-plan.json` are generation-relative
    // provenance keys: durable artifacts of this generation, not repository
    // sources. Phase 1 generations predate `run-plan.json` and simply have no
    // such key, so they continue to verify.
    const generationRelative =
      provenancePath === "config/profile.json" ||
      provenancePath === "run-plan.json" ||
      (state.legacyPhase1 &&
        (provenancePath === "config/contestants.yaml" ||
          provenancePath === "config/judges.yaml"));
    const sourcePath = generationRelative
      ? join(state.generationPath, provenancePath)
      : resolve(state.repositoryRoot, provenancePath);
    try {
      await verifyRegularFileHash(
        sourcePath,
        expectedHash,
        `source input ${provenancePath}`,
      );
    } catch (error) {
      if (
        provenancePath.startsWith("generations/") &&
        error instanceof Error &&
        /ENOENT|no such file|not found/iu.test(error.message)
      ) {
        continue;
      }
      throw error;
    }
  }
}

async function verifyContestantWorkspace(
  state: CanonicalGenerationState,
  workspacePath: string,
  prompt: string,
): Promise<void> {
  const expectedAssets = Object.keys(state.snapshot.assetHashes).filter(
    (relativePath) =>
      relativePath !== "fallback.css" && relativePath !== GALLERY_SOURCE_ARCHIVE_FILE,
  );
  for (const relativePath of expectedAssets) {
    await verifyRegularFileHash(
      join(workspacePath, relativePath),
      state.snapshot.assetHashes[relativePath]!,
      `contestant workspace input ${relativePath}`,
      workspacePath,
    );
  }
  const promptPath = join(workspacePath, "prompt.md");
  const promptFile = await readRegularFileAtMost(
    promptPath,
    Buffer.byteLength(prompt, "utf8"),
  );
  if (promptFile.kind !== "ok") {
    throw new Error("contestant workspace prompt is not a regular file");
  }
  if (promptFile.bytes.toString("utf8") !== prompt) {
    throw new Error("contestant workspace prompt changed");
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 4000 ? `${message.slice(0, 3997)}...` : message;
}

function boundedValidationError(error: unknown): string {
  const message = boundedError(error);
  return message.length > 2000 ? `${message.slice(0, 1997)}...` : message;
}

async function writeJsonArtifact<T>(
  path: string,
  schema: z.ZodType<T>,
  value: unknown,
): Promise<T> {
  const parsed = schema.parse(value);
  await writeTextAtomically(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

async function copyDeclaredFile(
  sourcePath: string,
  destinationPath: string,
  maximumBytes?: number,
): Promise<boolean> {
  const boundedSource = await readRegularFileAtMost(
    sourcePath,
    maximumBytes ?? 32 * 1024 * 1024,
  );
  if (boundedSource.kind !== "ok") return false;
  await mkdir(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.tmp-${process.pid}-${secureRandomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, boundedSource.bytes);
    if (maximumBytes !== undefined) {
      const copiedStatus = await lstat(temporaryPath);
      if (!copiedStatus.isFile() || copiedStatus.size > maximumBytes) return false;
    }
    await rename(temporaryPath, destinationPath);
    return true;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function relativeArtifactPath(rootPath: string, path: string): string {
  return relative(rootPath, path).split(sep).join("/");
}

function configuredContestantBudget(
  contestant: ContestantConfig,
  config: ContestantsConfig,
): { readonly timeoutMs: number; readonly maximumTotalTokens: number } {
  return (
    contestant.budget ?? {
      timeoutMs: config.defaults.timeoutMs,
      maximumTotalTokens: config.defaults.maximumTotalTokens,
    }
  );
}

function configuredJudgeBudget(
  judge: JudgeConfig,
  defaults: JudgesConfig["defaults"],
): {
  readonly timeoutMs: number;
  readonly maximumOutputTokens: number;
} {
  return (
    judge.budget ?? {
      timeoutMs: defaults.timeoutMs,
      maximumOutputTokens: defaults.maximumOutputTokens,
    }
  );
}

function defaultContestantAdapter(
  repositoryRoot: string,
  contestant: ContestantConfig,
): ContestantAdapter {
  return contestant.harness.adapter === "fixture"
    ? new FixtureContestantAdapter({
        fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
      })
    : new CommandContestantAdapter();
}

function defaultJudgeAdapter(judge: JudgeConfig): JudgeAdapter {
  return judge.harness.adapter === "fixture"
    ? new FixtureJudgeAdapter()
    : new CommandJudgeAdapter();
}

function executionFailureValidation(message: string): Validation {
  const boundedMessage = boundedValidationError(message);
  return ValidationSchema.parse({
    schemaVersion: 1,
    status: "invalid",
    submissionSha256: null,
    sanitisedSha256: null,
    submissionBytes: 0,
    staticChecks: [
      {
        code: "contestant_execution",
        status: "failed",
        message: boundedMessage || "contestant execution did not produce a submission",
      },
    ],
    renderChecks: [],
    errors: [boundedMessage || "contestant execution did not produce a submission"],
    warnings: [],
  });
}

function renderFailureValidation(
  validation: Validation,
  render: CandidateRenderResult,
): Validation {
  return ValidationSchema.parse({
    ...validation,
    status: "render_failed",
    renderChecks: render.renderChecks,
    renderEnvironment: render.observedVersions,
    errors: [...validation.errors, ...render.errors].map(boundedValidationError),
    warnings: [...validation.warnings, ...render.warnings].map(boundedValidationError),
  });
}

function validRenderValidation(
  validation: Validation,
  render: CandidateRenderResult,
): Validation {
  return ValidationSchema.parse({
    ...validation,
    status: "valid",
    renderChecks: render.renderChecks,
    renderEnvironment: render.observedVersions,
    errors: [...validation.errors, ...render.errors].map(boundedValidationError),
    warnings: [...validation.warnings, ...render.warnings].map(boundedValidationError),
  });
}

function contestantContactStatus(
  result: WaveBContestantResult,
):
  | "valid"
  | "invalid"
  | "render_failed"
  | "timeout"
  | "missing_submission"
  | "execution_failed" {
  if (result.validation.status === "valid") return "valid";
  if (result.validation.status === "render_failed") return "render_failed";
  if (result.run.status === "timeout") return "timeout";
  if (result.run.status === "missing_submission") return "missing_submission";
  if (result.run.status === "failed" || result.run.status === "uncertain")
    return "execution_failed";
  return "invalid";
}

function hashOrder(seed: string, ids: readonly string[]): string[] {
  return [...ids].sort((left, right) => {
    const leftHash = createHash("sha256").update(`${seed}\0${left}`).digest("hex");
    const rightHash = createHash("sha256").update(`${seed}\0${right}`).digest("hex");
    return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0;
  });
}

function domainSeparatedJudgeSeed(
  randomBytes: (size: number) => Buffer,
  generationId: string,
  judgeId: string,
  purpose: "contact-sheet" | "assessment",
): string {
  return createHash("sha256")
    .update("local-maxima/judge-seed/v1\0")
    .update(generationId)
    .update("\0")
    .update(judgeId)
    .update("\0")
    .update(purpose)
    .update("\0")
    .update(randomBytes(32))
    .digest("hex");
}

function differsFrom(order: readonly string[], other: readonly string[]): boolean {
  return (
    order.length !== other.length ||
    order.some((value, index) => value !== other[index])
  );
}

function independentOrder(
  seed: string,
  ids: readonly string[],
  executionOrder: readonly string[],
  contactOrder: readonly string[],
): string[] {
  const ordered = hashOrder(seed, ids);
  const candidates: string[][] = [ordered, [...ordered].reverse()];
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      const swapped = [...ordered];
      [swapped[left], swapped[right]] = [swapped[right]!, swapped[left]!];
      candidates.push(swapped);
    }
  }
  for (const offset of [1, -1]) {
    if (ordered.length < 2) continue;
    const rotated = ordered.map(
      (_, index) => ordered[(index + offset + ordered.length) % ordered.length]!,
    );
    candidates.push(rotated);
  }
  const selected = candidates.find(
    (candidate) =>
      differsFrom(candidate, executionOrder) && differsFrom(candidate, contactOrder),
  );
  if (selected !== undefined) {
    return selected;
  }
  return ordered;
}

async function updateManifest(
  generationPath: string,
  update: Partial<Manifest>,
): Promise<Manifest> {
  const path = join(generationPath, "manifest.json");
  const current = await readJsonWithSchema(path, ManifestSchema);
  return writeJsonArtifact(path, ManifestSchema, { ...current, ...update });
}

type TaskRole = WaveBTask["role"];
type TaskStateStatus = z.infer<typeof TaskStateStatusSchema>;

const TERMINAL_TASK_STATUSES = new Set<TaskStateStatus>([
  "succeeded",
  "failed",
  "timeout",
  "missing_submission",
  "invalid",
  "uncertain",
]);

function taskPath(generationPath: string, role: TaskRole, targetId: string): string {
  if (role === "contestant")
    return join(generationPath, "contestants", targetId, "task.json");
  if (role === "render")
    return join(generationPath, "contestants", targetId, "render-task.json");
  if (role === "judge") {
    const separator = targetId.indexOf("\0");
    if (separator < 1)
      throw new Error("judge task target must contain a judge and candidate ID");
    const judgeId = targetId.slice(0, separator);
    const anonymousCandidateId = targetId.slice(separator + 1);
    return join(
      generationPath,
      "judging",
      judgeId,
      "tasks",
      `${anonymousCandidateId}.json`,
    );
  }
  return join(generationPath, "judging", targetId, "awards-task.json");
}

function taskIdentifier(
  generationId: string,
  role: TaskRole,
  targetId: string,
): string {
  if (role === "judge") {
    const separator = targetId.indexOf("\0");
    const judgeId = targetId.slice(0, separator);
    const anonymousCandidateId = targetId.slice(separator + 1);
    return `${generationId}-judge-${judgeId}-${anonymousCandidateId}`;
  }
  return `${generationId}-${role}-${targetId}`;
}

async function readTaskState(path: string): Promise<TaskState | null> {
  if (!(await regularFileExists(path))) return null;
  return TaskStateSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function writeTaskState(
  path: string,
  value: {
    readonly taskId: string;
    readonly role: TaskRole;
    readonly targetId: string;
    readonly status: TaskStateStatus;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly attemptCount: number;
    readonly requestAccepted: boolean | null;
    readonly error: string | null;
  },
): Promise<TaskState> {
  return writeJsonArtifact(path, TaskStateSchema, {
    schemaVersion: 1,
    ...value,
  });
}

async function ensurePendingTaskState(
  generationPath: string,
  generationId: string,
  role: TaskRole,
  targetId: string,
): Promise<TaskState> {
  const path = taskPath(generationPath, role, targetId);
  const existing = await readTaskState(path);
  if (existing !== null) return existing;
  return writeTaskState(path, {
    taskId: taskIdentifier(generationId, role, targetId),
    role,
    targetId,
    status: "pending",
    startedAt: null,
    completedAt: null,
    attemptCount: 0,
    requestAccepted: null,
    error: null,
  });
}

async function beginTask(
  generationPath: string,
  generationId: string,
  role: TaskRole,
  targetId: string,
  clock: () => Date,
): Promise<TaskState> {
  const path = taskPath(generationPath, role, targetId);
  const existing = await ensurePendingTaskState(
    generationPath,
    generationId,
    role,
    targetId,
  );
  if (existing.status === "running" || TERMINAL_TASK_STATUSES.has(existing.status)) {
    return existing;
  }
  return writeTaskState(path, {
    taskId: existing.taskId,
    role,
    targetId,
    status: "running",
    startedAt: timestamp(clock()),
    completedAt: null,
    attemptCount: existing.attemptCount + 1,
    requestAccepted: null,
    error: null,
  });
}

async function finishTask(
  generationPath: string,
  generationId: string,
  role: TaskRole,
  targetId: string,
  status: Exclude<TaskStateStatus, "pending" | "running">,
  clock: () => Date,
  error: string | null,
  requestAccepted: boolean | null,
): Promise<TaskState> {
  const path = taskPath(generationPath, role, targetId);
  const existing = await ensurePendingTaskState(
    generationPath,
    generationId,
    role,
    targetId,
  );
  return writeTaskState(path, {
    taskId: existing.taskId,
    role,
    targetId,
    status,
    startedAt: existing.startedAt ?? timestamp(clock()),
    completedAt: timestamp(clock()),
    attemptCount: Math.max(1, existing.attemptCount),
    requestAccepted,
    error,
  });
}

async function markTaskUncertain(
  generationPath: string,
  generationId: string,
  role: TaskRole,
  targetId: string,
  clock: () => Date,
  error: string,
): Promise<TaskState> {
  return finishTask(
    generationPath,
    generationId,
    role,
    targetId,
    "uncertain",
    clock,
    error,
    null,
  );
}

function executionTaskStatus(
  run: Run,
): Exclude<TaskStateStatus, "pending" | "running"> {
  if (run.status === "succeeded") return "succeeded";
  if (run.status === "timeout") return "timeout";
  if (run.status === "missing_submission") return "missing_submission";
  if (run.status === "uncertain") return "uncertain";
  return "failed";
}

function renderTaskStatus(
  validation: Validation,
): Exclude<TaskStateStatus, "pending" | "running"> {
  if (validation.status === "valid") return "succeeded";
  return validation.status === "render_failed" ? "failed" : "invalid";
}

async function notifyTask(
  afterTask: WaveBRunOptions["afterTask"],
  task: WaveBTask,
): Promise<void> {
  try {
    await afterTask?.(task);
  } catch (error) {
    throw new WaveBInterruptionError(error);
  }
}

interface PendingCommandCalls {
  readonly contestantCalls: number;
  readonly candidateJudgingCalls: number;
  readonly awardsCalls: number;
}

async function readReusableCandidateJudgment(
  path: string,
  generationId: string,
  judgeId: string,
  anonymousCandidateId: string,
): Promise<z.infer<typeof CandidateJudgmentSchema> | null> {
  if (!(await regularFileExists(path))) return null;
  try {
    const judgment = await readJsonWithSchema(path, CandidateJudgmentSchema);
    if (
      judgment.generationId !== generationId ||
      judgment.judgeId !== judgeId ||
      judgment.anonymousCandidateId !== anonymousCandidateId
    ) {
      return null;
    }
    return judgment;
  } catch {
    return null;
  }
}

async function readReusableAwards(
  generationPath: string,
  generationId: string,
  judgeId: string,
  eligibleCandidates: readonly AnonymousCandidateIdentity[],
): Promise<z.infer<typeof GenerationAwardsSchema> | null> {
  const path = join(generationPath, "judging", judgeId, "awards.json");
  if (!(await regularFileExists(path))) return null;
  try {
    const awards = await readJsonWithSchema(
      path,
      createGenerationAwardsSchema(anonymousCandidateIds(eligibleCandidates)),
    );
    if (awards.generationId !== generationId || awards.judgeId !== judgeId) return null;
    return awards;
  } catch {
    return null;
  }
}

async function candidateMayBeRenderableOnResume(
  generationPath: string,
  contestant: ContestantConfig,
): Promise<boolean> {
  let run: Run;
  try {
    run = await readJsonWithSchema(
      join(generationPath, "contestants", contestant.id, "run.json"),
      RunSchema,
    );
  } catch {
    // Preserve the guard's conservative boundary when durable evidence is
    // missing or malformed.
    return true;
  }
  if (run.status === "running") return false;
  if (run.status === "pending") {
    const state = await readTaskState(
      taskPath(generationPath, "contestant", contestant.id),
    );
    return state === null || state.status === "pending";
  }
  if (run.status !== "succeeded") return false;

  let validation: Validation;
  try {
    validation = await readJsonWithSchema(
      join(generationPath, "contestants", contestant.id, "validation.json"),
      ValidationSchema,
    );
  } catch {
    // A succeeded execution with no usable validation is resumed from the
    // validation/render boundary and can still become renderable.
    return true;
  }
  if (validation.status !== "valid") return false;
  if (
    !(await regularFileExists(
      join(generationPath, "contestants", contestant.id, "screenshot.png"),
    ))
  ) {
    return true;
  }
  return isRenderableCandidate({
    run,
    validation,
    screenshotPath: join(
      generationPath,
      "contestants",
      contestant.id,
      "screenshot.png",
    ),
  });
}

function modelCallRefusalMessage(
  generationId: string,
  pending: PendingCommandCalls,
): string | null {
  const pendingTotal =
    pending.contestantCalls + pending.candidateJudgingCalls + pending.awardsCalls;
  if (pendingTotal === 0) return null;
  const parts: string[] = [];
  if (pending.contestantCalls > 0) {
    parts.push(`${String(pending.contestantCalls)} contestant call(s)`);
  }
  if (pending.candidateJudgingCalls > 0) {
    parts.push(
      `up to ${String(pending.candidateJudgingCalls)} candidate-judging call(s)`,
    );
  }
  if (pending.awardsCalls > 0) {
    parts.push(`up to ${String(pending.awardsCalls)} awards call(s)`);
  }
  return `generation ${generationId} may make external model calls: ${parts.join(", ")} pending; rerun with --allow-model-calls`;
}

async function refuseUnconsentedProfileBeforeCreation(
  options: WaveBRunOptions,
): Promise<void> {
  if (options.generationPath !== undefined || options.allowModelCalls === true) return;
  if (options.seasonId === undefined || options.profileId === undefined) return;

  const profile = await resolveProfile(
    resolve(options.repositoryRoot),
    options.profileId,
  );
  const contestants = profile.contestants.contestants.filter((entry) => entry.enabled);
  const judges = profile.judges.judges.filter((entry) => entry.enabled);
  const commandContestants = contestants.filter(
    (entry) => entry.harness.adapter === "command",
  );
  const commandJudges = judges.filter((entry) => entry.harness.adapter === "command");
  const generationId =
    options.generationId ??
    (await allocateGenerationId(
      resolve(options.generationsRoot ?? join(options.repositoryRoot, "generations")),
    ));
  const refusal = modelCallRefusalMessage(generationId, {
    contestantCalls: commandContestants.length,
    candidateJudgingCalls: contestants.length * commandJudges.length,
    awardsCalls: commandJudges.length,
  });
  if (refusal !== null) throw new Error(refusal);
}

/**
 * Counts the external model calls this run may still make through command
 * adapters. A resumable run only re-dispatches tasks that are missing or
 * still `pending` (running and terminal tasks are never retried); a
 * non-resumable run re-dispatches everything, so every command task counts.
 * Candidate-judging and awards calls are maximums because they only execute
 * after earlier stages succeed.
 */
async function countPendingCommandCalls(
  generationPath: string,
  generationId: string,
  commandContestants: readonly ContestantConfig[],
  commandJudges: readonly JudgeConfig[],
  rosterContestants: readonly ContestantConfig[],
  anonymousByContestant: ReadonlyMap<string, string>,
  resumable: boolean,
): Promise<PendingCommandCalls> {
  const callable = async (
    path: string,
    canDispatchWhenPending?: () => Promise<boolean>,
  ): Promise<boolean> => {
    if (!resumable) return true;
    const state = await readTaskState(path);
    if (state === null) {
      return canDispatchWhenPending === undefined ? true : canDispatchWhenPending();
    }
    if (state.status !== "pending") return false;
    return canDispatchWhenPending === undefined ? true : canDispatchWhenPending();
  };
  let contestantCalls = 0;
  for (const contestant of commandContestants) {
    if (
      await callable(
        taskPath(generationPath, "contestant", contestant.id),
        async () => {
          const runPath = join(
            generationPath,
            "contestants",
            contestant.id,
            "run.json",
          );
          if (!(await regularFileExists(runPath))) return true;
          try {
            const run = await readJsonWithSchema(runPath, RunSchema);
            return run.status === "pending";
          } catch {
            return true;
          }
        },
      )
    ) {
      contestantCalls += 1;
    }
  }
  let candidateJudgingCalls = 0;
  let awardsCalls = 0;
  const possiblyRenderableCandidates: AnonymousCandidateIdentity[] = [];
  for (const contestant of rosterContestants) {
    const anonymousCandidateId = anonymousByContestant.get(contestant.id);
    if (anonymousCandidateId === undefined) {
      throw new Error(`anonymous map is missing ${contestant.id}`);
    }
    if (!resumable) {
      possiblyRenderableCandidates.push({ anonymousCandidateId });
      continue;
    }
    if (await candidateMayBeRenderableOnResume(generationPath, contestant)) {
      possiblyRenderableCandidates.push({ anonymousCandidateId });
    }
  }
  for (const judge of commandJudges) {
    let candidateAssessmentsCanAllSucceed = possiblyRenderableCandidates.length > 0;
    const successfulOrDispatchable: AnonymousCandidateIdentity[] = [];
    for (const candidate of possiblyRenderableCandidates) {
      const anonymousCandidateId = candidate.anonymousCandidateId;
      const judgment = await readReusableCandidateJudgment(
        join(generationPath, "judging", judge.id, `${anonymousCandidateId}.json`),
        generationId,
        judge.id,
        anonymousCandidateId,
      );
      if (judgment !== null) {
        successfulOrDispatchable.push(candidate);
        continue;
      }
      if (!resumable) {
        candidateJudgingCalls += 1;
        successfulOrDispatchable.push(candidate);
        continue;
      }
      const state = await readTaskState(
        taskPath(generationPath, "judge", `${judge.id}\0${anonymousCandidateId}`),
      );
      if (state === null || state.status === "pending") {
        candidateJudgingCalls += 1;
        successfulOrDispatchable.push(candidate);
      } else {
        candidateAssessmentsCanAllSucceed = false;
      }
    }
    const reusableAwards = candidateAssessmentsCanAllSucceed
      ? await readReusableAwards(
          generationPath,
          generationId,
          judge.id,
          successfulOrDispatchable,
        )
      : null;
    if (
      candidateAssessmentsCanAllSucceed &&
      reusableAwards === null &&
      (await callable(taskPath(generationPath, "awards", judge.id)))
    ) {
      awardsCalls += 1;
    }
  }
  return { contestantCalls, candidateJudgingCalls, awardsCalls };
}

async function ensureContestantPrompt(
  contestantPath: string,
  workspacePath: string,
): Promise<string> {
  const prompt = buildContestantGenerationOnePrompt({
    submissionPath: join(workspacePath, "submission.css"),
    challengePath: join(workspacePath, "challenge.html"),
    starterCssPath: join(workspacePath, "starter.css"),
  });
  await writeTextAtomically(join(contestantPath, "prompt.md"), prompt);
  await writeTextAtomically(join(workspacePath, "prompt.md"), prompt);
  return prompt;
}

function adapterFailureResult(
  contestant: ContestantConfig,
  error: unknown,
): ContestantRunResult {
  return {
    status: "failed",
    exitCode: null,
    timedOut: false,
    attemptCount: 1,
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
    error: boundedError(error),
    submissionProduced: false,
    usageProduced: false,
    terminationSignals: [],
  };
}

interface RunContestantInput {
  readonly generationPath: string;
  readonly generationId: string;
  readonly contestant: ContestantConfig;
  readonly contestantsConfig: ContestantsConfig;
  readonly challengeConfig: ChallengeConfig;
  readonly anonymousCandidateId: string;
  readonly clock: () => Date;
  readonly canonicalState: CanonicalGenerationState;
  readonly adapter: ContestantAdapter;
  readonly renderer: {
    render(
      input: Parameters<typeof renderCandidate>[0],
    ): Promise<CandidateRenderResult>;
  };
  readonly onExecutionComplete?: (run: Run) => Promise<void>;
}

async function runOneContestant(
  input: RunContestantInput,
): Promise<WaveBContestantResult> {
  const contestantPath = join(input.generationPath, "contestants", input.contestant.id);
  const workspacePath = join(contestantPath, "workspace");
  const runPath = join(contestantPath, "run.json");
  // Capture admission time before the first filesystem await. The scheduler
  // invokes this mapper synchronously, so a concurrent paced admission cannot
  // advance the injected clock before an accepted execution records its start.
  const admittedAt = input.clock();
  const existingRun = await readJsonWithSchema(runPath, RunSchema);
  if (existingRun.status !== "pending") {
    await removeWorkspace(workspacePath);
    const validation = await readJsonWithSchema(
      join(contestantPath, "validation.json"),
      ValidationSchema,
    );
    return {
      contestantId: input.contestant.id,
      anonymousCandidateId: input.anonymousCandidateId,
      path: contestantPath,
      run: existingRun,
      validation,
      screenshotPath:
        validation.status === "valid" ? join(contestantPath, "screenshot.png") : null,
      integrityFailed: false,
      canonicalIntegrityFailed: false,
    };
  }

  const budget = configuredContestantBudget(input.contestant, input.contestantsConfig);
  const started = admittedAt;
  const startedAt = timestamp(started);
  const running = RunSchema.parse({
    ...existingRun,
    status: "running",
    startedAt,
    completedAt: null,
    durationMs: null,
    exitCode: null,
    timedOut: false,
    attemptCount: 1,
    configuredBudget: budget,
    error: null,
  });
  await writeJsonArtifact(runPath, RunSchema, running);
  let integrityError: string | null = null;
  let prompt: string | null = null;
  let runResult: ContestantRunResult = adapterFailureResult(
    input.contestant,
    "contestant execution did not start",
  );
  try {
    try {
      prompt = await ensureContestantPrompt(contestantPath, workspacePath);
      await verifyContestantWorkspace(input.canonicalState, workspacePath, prompt);
    } catch (error) {
      integrityError = `contestant workspace integrity check failed: ${boundedError(error)}`;
    }
    if (integrityError === null) {
      try {
        runResult = await input.adapter.run({
          generationId: input.generationId,
          contestantId: input.contestant.id,
          anonymousCandidateId: input.anonymousCandidateId,
          contestant: input.contestant,
          workspacePath,
          challengePath: join(workspacePath, "challenge.html"),
          starterCssPath: join(workspacePath, "starter.css"),
          promptPath: join(workspacePath, "prompt.md"),
          submissionPath: join(workspacePath, "submission.css"),
          usageOutputPath: join(workspacePath, "usage.json"),
          stdoutLogPath: join(input.generationPath, running.stdoutLog),
          stderrLogPath: join(input.generationPath, running.stderrLog),
          timeoutMs: budget.timeoutMs,
          maximumTotalTokens: budget.maximumTotalTokens,
        });
      } catch (error) {
        runResult = adapterFailureResult(input.contestant, error);
      }
      const postAttemptErrors: string[] = [];
      try {
        if (prompt === null) throw new Error("contestant prompt was not created");
        await verifyContestantWorkspace(input.canonicalState, workspacePath, prompt);
      } catch (error) {
        postAttemptErrors.push(
          `contestant workspace integrity check failed: ${boundedError(error)}`,
        );
      }
      try {
        await verifyCanonicalGenerationState(input.canonicalState);
      } catch (error) {
        postAttemptErrors.push(
          `canonical contestant input integrity check failed: ${boundedError(error)}`,
        );
      }
      if (postAttemptErrors.length > 0) integrityError = postAttemptErrors.join("; ");
    }
    if (integrityError !== null) {
      runResult = adapterFailureResult(input.contestant, integrityError);
    }
    const completed = input.clock();
    const completedAt = timestamp(completed);
    const submissionArtifactPath = join(contestantPath, "submission.css");
    const usageArtifactPath = join(contestantPath, "usage.json");
    let submissionCopied = false;
    if (integrityError === null) {
      try {
        submissionCopied = await copyDeclaredFile(
          join(workspacePath, "submission.css"),
          submissionArtifactPath,
          input.challengeConfig.submission.maximumBytes,
        );
        if (!submissionCopied && runResult.status === "succeeded") {
          runResult = {
            ...runResult,
            status: "failed",
            error: `${runResult.error ?? "contestant output collection failed"}; submission.css could not be collected`,
          };
        }
        const usagePath = join(workspacePath, "usage.json");
        if (await regularFileExists(usagePath)) {
          const usageCopied = await copyDeclaredFile(
            usagePath,
            usageArtifactPath,
            DEFAULT_USAGE_LIMIT_BYTES,
          );
          if (!usageCopied && runResult.status === "succeeded") {
            runResult = {
              ...runResult,
              status: "failed",
              error: `${runResult.error ?? "contestant output collection failed"}; usage metadata could not be collected`,
            };
          }
        }
      } catch (error) {
        runResult = {
          ...runResult,
          status: "failed",
          error: `${runResult.error ?? "contestant output collection failed"}; ${boundedError(error)}`,
        };
      }
    }
    let completedRun = RunSchema.parse({
      ...running,
      status: runResult.status,
      completedAt,
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
      exitCode: runResult.exitCode,
      timedOut: runResult.timedOut,
      attemptCount: runResult.attemptCount,
      usage: runResult.usage,
      observedVersions: runResult.observedVersions,
      error: integrityError ?? runResult.error,
    });
    await writeJsonArtifact(runPath, RunSchema, completedRun);
    await input.onExecutionComplete?.(completedRun);

    let validation: Validation;
    if (
      integrityError !== null ||
      completedRun.status !== "succeeded" ||
      !submissionCopied
    ) {
      validation = executionFailureValidation(
        completedRun.error ??
          (submissionCopied
            ? "contestant execution did not succeed"
            : "contestant produced no submission.css"),
      );
    } else {
      try {
        try {
          await verifyCanonicalGenerationState(input.canonicalState);
        } catch (error) {
          integrityError = `canonical contestant input integrity check failed: ${boundedError(error)}`;
          throw new Error(integrityError);
        }
        const staticResult = await validateSubmission({
          submissionPath: submissionArtifactPath,
          challengeRoot: join(input.generationPath, "challenge"),
          starterCssPath: join(input.generationPath, "challenge/starter.css"),
          maximumBytes: input.challengeConfig.submission.maximumBytes,
        });
        validation = staticResult.validation;
        if (staticResult.sanitisedCss !== null) {
          if (validation.sanitisedSha256 === null) {
            throw new Error("valid CSS validation is missing its sanitised hash");
          }
          const sanitisedPath = join(contestantPath, "sanitised.css");
          await writeTextAtomically(sanitisedPath, staticResult.sanitisedCss);
          await verifyRegularFileHash(
            sanitisedPath,
            validation.sanitisedSha256,
            "sanitised CSS",
            contestantPath,
          );
          try {
            await verifyCanonicalGenerationState(input.canonicalState);
          } catch (error) {
            integrityError = `canonical contestant input integrity check failed: ${boundedError(error)}`;
            throw new Error(integrityError);
          }
          const render = await input.renderer.render({
            candidateRootPath: workspacePath,
            canonicalChallengeRootPath: join(input.generationPath, "challenge"),
            submissionPath: submissionArtifactPath,
            screenshotPath: join(contestantPath, "screenshot.png"),
            challengeConfig: input.challengeConfig,
          });
          try {
            await verifyCanonicalGenerationState(input.canonicalState);
          } catch (error) {
            integrityError = `canonical contestant input integrity check failed: ${boundedError(error)}`;
            await rm(join(contestantPath, "screenshot.png"), { force: true });
            throw new Error(integrityError);
          }
          validation =
            render.status === "valid"
              ? validRenderValidation(validation, render)
              : renderFailureValidation(validation, render);
        }
      } catch (error) {
        if (integrityError === null) {
          try {
            await verifyCanonicalGenerationState(input.canonicalState);
          } catch (canonicalError) {
            integrityError = `canonical contestant input integrity check failed: ${boundedError(canonicalError)}`;
          }
        }
        if (integrityError !== null) {
          completedRun = RunSchema.parse({
            ...completedRun,
            status: "failed",
            error: integrityError,
          });
          await writeJsonArtifact(runPath, RunSchema, completedRun);
          validation = executionFailureValidation(integrityError);
        } else {
          validation = ValidationSchema.parse({
            schemaVersion: 1,
            status: "invalid",
            submissionSha256: null,
            sanitisedSha256: null,
            submissionBytes: 0,
            staticChecks: [
              {
                code: "validation_execution",
                status: "failed",
                message: boundedError(error),
              },
            ],
            renderChecks: [],
            errors: [boundedError(error)],
            warnings: [],
          });
        }
      }
    }
    await writeJsonArtifact(
      join(contestantPath, "validation.json"),
      ValidationSchema,
      validation,
    );
    return {
      contestantId: input.contestant.id,
      anonymousCandidateId: input.anonymousCandidateId,
      path: contestantPath,
      run: completedRun,
      validation,
      screenshotPath:
        validation.status === "valid" ? join(contestantPath, "screenshot.png") : null,
      integrityFailed: integrityError !== null,
      canonicalIntegrityFailed:
        integrityError?.includes("canonical contestant input integrity check failed") ??
        false,
    };
  } finally {
    await removeWorkspace(workspacePath);
  }
}

async function restoreContestantWorkspace(input: RunContestantInput): Promise<string> {
  const contestantPath = join(input.generationPath, "contestants", input.contestant.id);
  const workspacePath = join(contestantPath, "workspace");
  await removeWorkspace(workspacePath);
  await mkdir(workspacePath, { recursive: true });
  for (const relativePath of Object.keys(
    input.canonicalState.snapshot.assetHashes,
  ).filter((file) => file !== "fallback.css" && file !== GALLERY_SOURCE_ARCHIVE_FILE)) {
    const sourcePath = join(input.generationPath, "challenge", relativePath);
    const destinationPath = join(workspacePath, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
  const prompt = await ensureContestantPrompt(contestantPath, workspacePath);
  await verifyContestantWorkspace(input.canonicalState, workspacePath, prompt);
  return prompt;
}

async function continueContestantAfterExecution(
  input: RunContestantInput,
  existingRun: Run,
): Promise<WaveBContestantResult> {
  const contestantPath = join(input.generationPath, "contestants", input.contestant.id);
  const workspacePath = join(contestantPath, "workspace");
  const submissionArtifactPath = join(contestantPath, "submission.css");
  let completedRun = existingRun;
  let integrityError: string | null = null;
  let validation: Validation;
  try {
    await restoreContestantWorkspace(input);
    try {
      await verifyCanonicalGenerationState(input.canonicalState);
    } catch (error) {
      integrityError = `canonical contestant input integrity check failed: ${boundedError(error)}`;
      throw new Error(integrityError);
    }
    const staticResult = await validateSubmission({
      submissionPath: submissionArtifactPath,
      challengeRoot: join(input.generationPath, "challenge"),
      starterCssPath: join(input.generationPath, "challenge/starter.css"),
      maximumBytes: input.challengeConfig.submission.maximumBytes,
    });
    validation = staticResult.validation;
    if (staticResult.sanitisedCss !== null) {
      if (validation.sanitisedSha256 === null) {
        throw new Error("valid CSS validation is missing its sanitised hash");
      }
      const sanitisedPath = join(contestantPath, "sanitised.css");
      await writeTextAtomically(sanitisedPath, staticResult.sanitisedCss);
      await verifyRegularFileHash(
        sanitisedPath,
        validation.sanitisedSha256,
        "sanitised CSS",
        contestantPath,
      );
      await verifyCanonicalGenerationState(input.canonicalState);
      const render = await input.renderer.render({
        candidateRootPath: workspacePath,
        canonicalChallengeRootPath: join(input.generationPath, "challenge"),
        submissionPath: submissionArtifactPath,
        screenshotPath: join(contestantPath, "screenshot.png"),
        challengeConfig: input.challengeConfig,
      });
      try {
        await verifyCanonicalGenerationState(input.canonicalState);
      } catch (error) {
        integrityError = `canonical contestant input integrity check failed: ${boundedError(error)}`;
        await rm(join(contestantPath, "screenshot.png"), { force: true });
        throw new Error(integrityError);
      }
      validation =
        render.status === "valid"
          ? validRenderValidation(validation, render)
          : renderFailureValidation(validation, render);
    }
  } catch (error) {
    if (integrityError === null) {
      try {
        await verifyCanonicalGenerationState(input.canonicalState);
      } catch (canonicalError) {
        integrityError = `canonical contestant input integrity check failed: ${boundedError(canonicalError)}`;
      }
    }
    if (integrityError !== null) {
      completedRun = RunSchema.parse({
        ...completedRun,
        status: "failed",
        error: integrityError,
      });
      await writeJsonArtifact(
        join(contestantPath, "run.json"),
        RunSchema,
        completedRun,
      );
      validation = executionFailureValidation(integrityError);
    } else {
      validation = executionFailureValidation(boundedError(error));
    }
  } finally {
    await removeWorkspace(workspacePath);
  }
  await writeJsonArtifact(
    join(contestantPath, "validation.json"),
    ValidationSchema,
    validation,
  );
  return {
    contestantId: input.contestant.id,
    anonymousCandidateId: input.anonymousCandidateId,
    path: contestantPath,
    run: completedRun,
    validation,
    screenshotPath:
      validation.status === "valid" &&
      (await regularFileExists(join(contestantPath, "screenshot.png")))
        ? join(contestantPath, "screenshot.png")
        : null,
    integrityFailed: integrityError !== null,
    canonicalIntegrityFailed:
      integrityError?.includes("canonical contestant input integrity check failed") ??
      false,
  };
}

async function readContestantResult(
  generationPath: string,
  contestant: ContestantConfig,
  anonymousCandidateId: string,
): Promise<WaveBContestantResult> {
  const contestantPath = join(generationPath, "contestants", contestant.id);
  const run = await readJsonWithSchema(join(contestantPath, "run.json"), RunSchema);
  const validation = await readJsonWithSchema(
    join(contestantPath, "validation.json"),
    ValidationSchema,
  );
  return {
    contestantId: contestant.id,
    anonymousCandidateId,
    path: contestantPath,
    run,
    validation,
    screenshotPath:
      validation.status === "valid" &&
      (await regularFileExists(join(contestantPath, "screenshot.png")))
        ? join(contestantPath, "screenshot.png")
        : null,
    integrityFailed: false,
    canonicalIntegrityFailed: false,
  };
}

async function markContestantUncertain(input: {
  readonly generationPath: string;
  readonly generationId: string;
  readonly contestant: ContestantConfig;
  readonly anonymousCandidateId: string;
  readonly clock: () => Date;
  readonly reason: string;
}): Promise<WaveBContestantResult> {
  const contestantPath = join(input.generationPath, "contestants", input.contestant.id);
  const runPath = join(contestantPath, "run.json");
  const existingRun = await readJsonWithSchema(runPath, RunSchema);
  const completedAt = timestamp(input.clock());
  const startedAt = existingRun.startedAt ?? completedAt;
  const startedTime = Date.parse(startedAt);
  const completedTime = Date.parse(completedAt);
  const uncertainRun = RunSchema.parse({
    ...existingRun,
    status: "uncertain",
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedTime - startedTime),
    attemptCount: Math.max(1, existingRun.attemptCount),
    error: input.reason,
  });
  await writeJsonArtifact(runPath, RunSchema, uncertainRun);
  const validation = executionFailureValidation(input.reason);
  await writeJsonArtifact(
    join(contestantPath, "validation.json"),
    ValidationSchema,
    validation,
  );
  await finishTask(
    input.generationPath,
    input.generationId,
    "contestant",
    input.contestant.id,
    "uncertain",
    input.clock,
    input.reason,
    null,
  );
  return {
    contestantId: input.contestant.id,
    anonymousCandidateId: input.anonymousCandidateId,
    path: contestantPath,
    run: uncertainRun,
    validation,
    screenshotPath: null,
    integrityFailed: false,
    canonicalIntegrityFailed: false,
  };
}

async function runOneContestantResumable(
  input: RunContestantInput & {
    readonly generationId: string;
    readonly options: WaveBRunOptions;
  },
): Promise<WaveBContestantResult> {
  const contestantPath = join(input.generationPath, "contestants", input.contestant.id);
  const run = await readJsonWithSchema(join(contestantPath, "run.json"), RunSchema);
  const executionTask = await ensurePendingTaskState(
    input.generationPath,
    input.generationId,
    "contestant",
    input.contestant.id,
  );
  const validationExists = await regularFileExists(
    join(contestantPath, "validation.json"),
  );
  const existingValidation = validationExists
    ? await readJsonWithSchema(
        join(contestantPath, "validation.json"),
        ValidationSchema,
      )
    : null;
  const screenshotExists = await regularFileExists(
    join(contestantPath, "screenshot.png"),
  );

  if (
    run.status === "running" ||
    (run.status === "pending" && executionTask.status !== "pending")
  ) {
    const reason =
      run.status === "pending" && executionTask.status !== "pending"
        ? "contestant task state was not pending while contestant execution was pending; request outcome is uncertain"
        : "contestant task was running when the generation was resumed; request outcome is uncertain";
    const result = await markContestantUncertain({
      generationPath: input.generationPath,
      generationId: input.generationId,
      contestant: input.contestant,
      anonymousCandidateId: input.anonymousCandidateId,
      clock: input.clock,
      reason,
    });
    await finishTask(
      input.generationPath,
      input.generationId,
      "render",
      input.contestant.id,
      "invalid",
      input.clock,
      "render was not run because contestant execution outcome is uncertain",
      null,
    );
    return result;
  }

  if (executionTask.status === "running") {
    await finishTask(
      input.generationPath,
      input.generationId,
      "contestant",
      input.contestant.id,
      executionTaskStatus(run),
      input.clock,
      run.error,
      run.status === "succeeded" ? true : null,
    );
  }

  if (
    run.status === "succeeded" &&
    (existingValidation === null ||
      (existingValidation.status === "valid" && !screenshotExists))
  ) {
    if (executionTask.status === "pending") {
      await finishTask(
        input.generationPath,
        input.generationId,
        "contestant",
        input.contestant.id,
        "succeeded",
        input.clock,
        null,
        true,
      );
    }
    const result = await continueContestantAfterExecution(input, run);
    await finishTask(
      input.generationPath,
      input.generationId,
      "render",
      input.contestant.id,
      renderTaskStatus(result.validation),
      input.clock,
      result.validation.errors[0] ?? null,
      null,
    );
    await notifyTask(input.options.afterTask, {
      role: "render",
      targetId: input.contestant.id,
      taskId: taskIdentifier(input.generationId, "render", input.contestant.id),
    });
    return result;
  }

  if (run.status !== "pending") {
    const validation = existingValidation;
    if (validation !== null && executionTask.status === "pending") {
      await finishTask(
        input.generationPath,
        input.generationId,
        "contestant",
        input.contestant.id,
        executionTaskStatus(run),
        input.clock,
        run.error,
        run.status === "succeeded" ? true : null,
      );
    }
    const completedRenderTask = await ensurePendingTaskState(
      input.generationPath,
      input.generationId,
      "render",
      input.contestant.id,
    );
    if (validation !== null && completedRenderTask.status === "pending") {
      await finishTask(
        input.generationPath,
        input.generationId,
        "render",
        input.contestant.id,
        renderTaskStatus(validation),
        input.clock,
        validation.errors[0] ?? null,
        null,
      );
      return readContestantResult(
        input.generationPath,
        input.contestant,
        input.anonymousCandidateId,
      );
    }
    if (validation !== null) {
      return readContestantResult(
        input.generationPath,
        input.contestant,
        input.anonymousCandidateId,
      );
    }
    if (!validationExists) {
      const failureValidation = executionFailureValidation(
        run.error ?? "contestant task completed without a validation artifact",
      );
      await writeJsonArtifact(
        join(contestantPath, "validation.json"),
        ValidationSchema,
        failureValidation,
      );
    }
    if (executionTask.status === "pending") {
      await finishTask(
        input.generationPath,
        input.generationId,
        "contestant",
        input.contestant.id,
        executionTaskStatus(run),
        input.clock,
        run.error,
        null,
      );
    }
    const renderTask = await ensurePendingTaskState(
      input.generationPath,
      input.generationId,
      "render",
      input.contestant.id,
    );
    if (renderTask.status === "pending") {
      await finishTask(
        input.generationPath,
        input.generationId,
        "render",
        input.contestant.id,
        "invalid",
        input.clock,
        "render was not run because contestant execution did not succeed",
        null,
      );
    }
    return readContestantResult(
      input.generationPath,
      input.contestant,
      input.anonymousCandidateId,
    );
  }

  await beginTask(
    input.generationPath,
    input.generationId,
    "contestant",
    input.contestant.id,
    input.clock,
  );
  const result = await runOneContestant({
    ...input,
    onExecutionComplete: async (completedRun) => {
      await finishTask(
        input.generationPath,
        input.generationId,
        "contestant",
        input.contestant.id,
        executionTaskStatus(completedRun),
        input.clock,
        completedRun.error,
        completedRun.status === "succeeded" ? true : null,
      );
      await notifyTask(input.options.afterTask, {
        role: "contestant",
        targetId: input.contestant.id,
        taskId: taskIdentifier(input.generationId, "contestant", input.contestant.id),
      });
    },
  });
  await finishTask(
    input.generationPath,
    input.generationId,
    "render",
    input.contestant.id,
    renderTaskStatus(result.validation),
    input.clock,
    result.validation.errors[0] ?? null,
    null,
  );
  await notifyTask(input.options.afterTask, {
    role: "render",
    targetId: input.contestant.id,
    taskId: taskIdentifier(input.generationId, "render", input.contestant.id),
  });
  return result;
}

async function stageFile(
  sourcePath: string,
  destinationPath: string,
  maximumBytes = 32 * 1024 * 1024,
): Promise<void> {
  if (!(await copyDeclaredFile(sourcePath, destinationPath, maximumBytes))) {
    throw new Error(
      `required staged input is unavailable: ${relativeArtifactPath(dirname(destinationPath), sourcePath)}`,
    );
  }
}

async function archiveRawOutput(
  path: string,
  rawOutput: string | null,
  error: string | null,
): Promise<void> {
  if (rawOutput !== null) {
    await writeTextAtomically(path, rawOutput);
  } else {
    await writeTextAtomically(
      path.replace(/\.json$/u, ".txt"),
      `No raw output was produced. ${error ?? "unknown error"}\n`,
    );
  }
}

async function judgeOne(
  adapter: JudgeAdapter,
  input: Parameters<JudgeAdapter["scoreCandidate"]>[0],
): Promise<JudgeCandidateResult> {
  try {
    return await adapter.scoreCandidate(input);
  } catch (error) {
    return {
      status: "failed",
      response: null,
      judgment: null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostUsd: null,
      },
      rawOutput: null,
      error: boundedError(error),
      timedOut: false,
      attemptCount: 1,
    };
  }
}

function makeJudgeAdapterFailure(error: unknown): JudgeAwardsResult {
  return {
    status: "failed",
    awards: null,
    rawOutput: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
    },
    error: boundedError(error),
    timedOut: false,
    attemptCount: 1,
  };
}

function awardsTaskStatus(
  result: JudgeAwardsResult,
): Exclude<TaskStateStatus, "pending" | "running"> {
  if (result.status === "succeeded" && result.awards !== null) return "succeeded";
  if (result.status === "timeout") return "timeout";
  if (result.status === "invalid") return "invalid";
  return "failed";
}

function awardsResultFromTask(state: TaskState): JudgeAwardsResult {
  const status =
    state.status === "invalid"
      ? "invalid"
      : state.status === "timeout"
        ? "timeout"
        : "failed";
  return {
    status,
    awards: null,
    rawOutput: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
    },
    error: state.error ?? `awards task ended with status ${state.status}`,
    timedOut: status === "timeout",
    attemptCount: 1,
  };
}

function makeJudgeCandidateFailure(error: unknown): JudgeCandidateResult {
  return {
    status: "failed",
    response: null,
    judgment: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
    },
    rawOutput: null,
    error: boundedError(error),
    timedOut: false,
    attemptCount: 1,
  };
}

function judgeTaskStatus(
  result: JudgeCandidateResult,
): Exclude<TaskStateStatus, "pending" | "running"> {
  if (result.status === "succeeded" && result.judgment !== null) return "succeeded";
  if (result.status === "timeout") return "timeout";
  if (result.status === "invalid") return "invalid";
  return "failed";
}

function judgeResultFromTask(state: TaskState): JudgeCandidateResult {
  const status =
    state.status === "invalid"
      ? "invalid"
      : state.status === "timeout"
        ? "timeout"
        : "failed";
  return {
    status,
    response: null,
    judgment: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
    },
    rawOutput: null,
    error: state.error ?? `judge task ended with status ${state.status}`,
    timedOut: status === "timeout",
    attemptCount: 1,
  };
}

async function writePrivateFailure(path: string, error: unknown): Promise<void> {
  await writeTextAtomically(path, `${boundedError(error)}\n`).catch(() => undefined);
}

async function awardsOne(
  adapter: JudgeAdapter,
  input: JudgeAwardsInput,
): Promise<JudgeAwardsResult> {
  try {
    return await adapter.createAwards(input);
  } catch (error) {
    return makeJudgeAdapterFailure(error);
  }
}

async function makeJudgeFailureResult(
  generationPath: string,
  judgeId: string,
  error: unknown,
): Promise<WaveBJudgeResult> {
  const judgePath = join(generationPath, "judging", judgeId);
  const failure = `judge stage failed: ${boundedError(error)}`;
  await mkdir(judgePath, { recursive: true }).catch(() => undefined);
  await writePrivateFailure(join(judgePath, "failure.txt"), failure);
  return {
    judgeId,
    path: judgePath,
    contactSheet: null,
    assessmentOrder: [],
    assessmentOrderPath: null,
    candidates: [],
    awards: null,
    awardsTiming: null,
    failure,
  };
}

async function markJudgeSetupFailure(input: {
  readonly generationPath: string;
  readonly generationId: string;
  readonly judgeId: string;
  readonly contestants: readonly WaveBContestantResult[];
  readonly clock: () => Date;
  readonly reason: string;
}): Promise<void> {
  const finishPending = async (
    role: "judge" | "awards",
    targetId: string,
  ): Promise<void> => {
    const task = await ensurePendingTaskState(
      input.generationPath,
      input.generationId,
      role,
      targetId,
    );
    if (task.status === "pending") {
      await finishTask(
        input.generationPath,
        input.generationId,
        role,
        targetId,
        "failed",
        input.clock,
        input.reason,
        null,
      );
    } else if (task.status === "running") {
      await markTaskUncertain(
        input.generationPath,
        input.generationId,
        role,
        targetId,
        input.clock,
        input.reason,
      );
    }
  };
  await Promise.all([
    ...input.contestants.map((contestant) =>
      finishPending("judge", `${input.judgeId}\0${contestant.anonymousCandidateId}`),
    ),
    finishPending("awards", input.judgeId),
  ]);
}

async function loadReusableContactSheet(input: {
  readonly generationPath: string;
  readonly generationId: string;
  readonly judgeId: string;
  readonly candidateIds: readonly string[];
}): Promise<AnonymousContactSheetResult | null> {
  const outputPath = join(
    input.generationPath,
    "judging",
    input.judgeId,
    "contact-sheet.png",
  );
  const orderPath = join(
    input.generationPath,
    "judging",
    input.judgeId,
    "contact-sheet-order.json",
  );
  if (!(await regularFileExists(outputPath)) || !(await regularFileExists(orderPath))) {
    return null;
  }
  try {
    const order = await readJsonWithSchema(orderPath, ContactSheetOrderSchema);
    if (
      order.generationId !== input.generationId ||
      order.judgeId !== input.judgeId ||
      order.candidateOrder.length !== input.candidateIds.length ||
      [...order.candidateOrder]
        .sort()
        .some(
          (candidateId, index) => candidateId !== [...input.candidateIds].sort()[index],
        )
    ) {
      return null;
    }
    return {
      seed: order.seed,
      candidateOrder: order.candidateOrder,
      outputPath,
      orderPath,
    };
  } catch {
    return null;
  }
}

async function loadReusableAssessmentOrder(input: {
  readonly path: string;
  readonly generationId: string;
  readonly judgeId: string;
  readonly candidateIds: readonly string[];
}): Promise<z.infer<typeof JudgeAssessmentOrderSchema> | null> {
  if (!(await regularFileExists(input.path))) return null;
  try {
    const order = await readJsonWithSchema(input.path, JudgeAssessmentOrderSchema);
    if (
      order.generationId !== input.generationId ||
      order.judgeId !== input.judgeId ||
      order.assessmentOrder.length !== input.candidateIds.length ||
      [...order.assessmentOrder]
        .sort()
        .some(
          (candidateId, index) => candidateId !== [...input.candidateIds].sort()[index],
        )
    ) {
      return null;
    }
    return order;
  } catch {
    return null;
  }
}

async function runOneJudge(input: {
  readonly generationPath: string;
  readonly generationId: string;
  readonly judge: JudgeConfig;
  readonly judgeDefaults: JudgesConfig["defaults"];
  readonly contestants: readonly WaveBContestantResult[];
  readonly clock: () => Date;
  readonly randomBytes: (size: number) => Buffer;
  readonly adapter: JudgeAdapter;
  readonly scheduler: ResourceAwareScheduler;
  readonly contactSheetBuilder: (
    input: Parameters<typeof buildAnonymousContactSheet>[0],
  ) => Promise<AnonymousContactSheetResult>;
  readonly resumable?: boolean;
  readonly afterTask?: (task: WaveBTask) => void | Promise<void>;
}): Promise<WaveBJudgeResult> {
  const judgePath = join(input.generationPath, "judging", input.judge.id);
  let contact: AnonymousContactSheetResult | null = null;
  let judgeFailure: string | null = null;
  try {
    await mkdir(judgePath, { recursive: true });
    await removeWorkspace(join(judgePath, "workspaces"));
    await removeWorkspace(join(judgePath, "awards-workspace"));
    contact =
      (input.resumable === true
        ? await loadReusableContactSheet({
            generationPath: input.generationPath,
            generationId: input.generationId,
            judgeId: input.judge.id,
            candidateIds: input.contestants.map(
              (contestant) => contestant.anonymousCandidateId,
            ),
          })
        : null) ??
      (await input.contactSheetBuilder({
        generationId: input.generationId,
        judgeId: input.judge.id,
        candidates: input.contestants.map((contestant) => ({
          anonymousCandidateId: contestant.anonymousCandidateId,
          validationStatus: contestantContactStatus(contestant),
          screenshotPath: contestant.screenshotPath,
        })),
        outputPath: join(judgePath, "contact-sheet.png"),
        orderPath: join(judgePath, "contact-sheet-order.json"),
        seed: domainSeparatedJudgeSeed(
          input.randomBytes,
          input.generationId,
          input.judge.id,
          "contact-sheet",
        ),
      }));
  } catch (error) {
    judgeFailure = `contact-sheet setup failed: ${boundedError(error)}`;
    await rm(join(judgePath, "contact-sheet.png"), { force: true }).catch(
      () => undefined,
    );
    await rm(join(judgePath, "contact-sheet-order.json"), { force: true }).catch(
      () => undefined,
    );
    await writePrivateFailure(join(judgePath, "failure.txt"), judgeFailure);
    if (input.resumable === true) {
      await markJudgeSetupFailure({
        generationPath: input.generationPath,
        generationId: input.generationId,
        judgeId: input.judge.id,
        contestants: input.contestants,
        clock: input.clock,
        reason: judgeFailure,
      });
    }
    return {
      judgeId: input.judge.id,
      path: judgePath,
      contactSheet: null,
      assessmentOrder: [],
      assessmentOrderPath: null,
      candidates: [],
      awards: null,
      awardsTiming: null,
      failure: judgeFailure,
    };
  }

  const renderable = renderableCandidates(input.contestants);
  if (input.resumable === true) {
    const renderableIds = new Set(
      renderable.map((contestant) => contestant.anonymousCandidateId),
    );
    await Promise.all(
      input.contestants
        .filter((contestant) => !renderableIds.has(contestant.anonymousCandidateId))
        .map(async (contestant) => {
          const anonymousCandidateId = contestant.anonymousCandidateId;
          const taskTargetId = `${input.judge.id}\0${anonymousCandidateId}`;
          const task = await ensurePendingTaskState(
            input.generationPath,
            input.generationId,
            "judge",
            taskTargetId,
          );
          if (task.status === "pending") {
            await finishTask(
              input.generationPath,
              input.generationId,
              "judge",
              taskTargetId,
              "invalid",
              input.clock,
              "candidate is not renderable",
              null,
            );
          }
        }),
    );
  }
  const executionOrder = renderable.map(
    (contestant) => contestant.anonymousCandidateId,
  );
  const contactRenderableOrder = contact.candidateOrder.filter((candidateId) =>
    executionOrder.includes(candidateId),
  );
  const assessmentOrderPath =
    renderable.length === 0 ? null : join(judgePath, "assessment-order.json");
  const reusableAssessment =
    input.resumable === true && assessmentOrderPath !== null
      ? await loadReusableAssessmentOrder({
          path: assessmentOrderPath,
          generationId: input.generationId,
          judgeId: input.judge.id,
          candidateIds: executionOrder,
        })
      : null;
  const assessmentSeed =
    reusableAssessment?.seed ??
    domainSeparatedJudgeSeed(
      input.randomBytes,
      input.generationId,
      input.judge.id,
      "assessment",
    );
  const assessmentOrder =
    reusableAssessment?.assessmentOrder ??
    independentOrder(
      assessmentSeed,
      executionOrder,
      executionOrder,
      contactRenderableOrder,
    );
  try {
    if (assessmentOrderPath !== null && reusableAssessment === null) {
      await writeJsonArtifact(assessmentOrderPath, JudgeAssessmentOrderSchema, {
        schemaVersion: 1,
        generationId: input.generationId,
        judgeId: input.judge.id,
        seed: assessmentSeed,
        assessmentOrder,
      });
    }
  } catch (error) {
    judgeFailure = `assessment-order setup failed: ${boundedError(error)}`;
    await writePrivateFailure(join(judgePath, "failure.txt"), judgeFailure);
    if (input.resumable === true) {
      await markJudgeSetupFailure({
        generationPath: input.generationPath,
        generationId: input.generationId,
        judgeId: input.judge.id,
        contestants: input.contestants,
        clock: input.clock,
        reason: judgeFailure,
      });
    }
    return {
      judgeId: input.judge.id,
      path: judgePath,
      contactSheet: contact,
      assessmentOrder: [],
      assessmentOrderPath: null,
      candidates: [],
      awards: null,
      awardsTiming: null,
      failure: judgeFailure,
    };
  }

  const contestantsByAnonymousId = new Map(
    renderable.map((contestant) => [contestant.anonymousCandidateId, contestant]),
  );
  const budget = configuredJudgeBudget(input.judge, input.judgeDefaults);
  const assessmentItems = await Promise.all(
    assessmentOrder.map(async (anonymousCandidateId) => {
      const needsAdapterCall = await judgeCandidateNeedsAdapterCall({
        generationPath: input.generationPath,
        generationId: input.generationId,
        judge: input.judge,
        judgePath,
        anonymousCandidateId,
        contestant: contestantsByAnonymousId.get(anonymousCandidateId),
        resumable: input.resumable === true,
      });
      const resourceGroup = input.judge.execution?.resourceGroup;
      return needsAdapterCall && resourceGroup !== undefined
        ? { value: anonymousCandidateId, resourceGroup }
        : { value: anonymousCandidateId };
    }),
  );
  const candidateResults = await input.scheduler
    .map<string, WaveBJudgeCandidateResult>(
      assessmentItems,
      async (anonymousCandidateId): Promise<WaveBJudgeCandidateResult> => {
        const taskStarted = input.clock();
        const taskStartedAt = timestamp(taskStarted);
        const taskTargetId = `${input.judge.id}\0${anonymousCandidateId}`;
        const candidateTask =
          input.resumable === true
            ? await ensurePendingTaskState(
                input.generationPath,
                input.generationId,
                "judge",
                taskTargetId,
              )
            : null;
        const contestant = contestantsByAnonymousId.get(anonymousCandidateId);
        if (contestant === undefined || contestant.screenshotPath === null) {
          const taskCompleted = input.clock();
          if (input.resumable === true && candidateTask !== null) {
            const taskResult =
              candidateTask.status === "running"
                ? await markTaskUncertain(
                    input.generationPath,
                    input.generationId,
                    "judge",
                    taskTargetId,
                    input.clock,
                    "candidate is not renderable after an interrupted judge task",
                  )
                : candidateTask;
            if (taskResult.status === "pending") {
              await finishTask(
                input.generationPath,
                input.generationId,
                "judge",
                taskTargetId,
                "invalid",
                input.clock,
                "candidate is not renderable",
                null,
              );
            }
          }
          return {
            anonymousCandidateId,
            result: makeJudgeCandidateFailure("candidate is not renderable"),
            durablePath: null,
            startedAt: taskStartedAt,
            completedAt: timestamp(taskCompleted),
            durationMs: Math.max(0, taskCompleted.getTime() - taskStarted.getTime()),
          };
        }
        if (input.resumable === true && candidateTask !== null) {
          const durablePath = join(judgePath, `${anonymousCandidateId}.json`);
          let durableJudgment: z.infer<typeof CandidateJudgmentSchema> | null = null;
          durableJudgment = await readReusableCandidateJudgment(
            durablePath,
            input.generationId,
            input.judge.id,
            anonymousCandidateId,
          );
          if (durableJudgment !== null) {
            if (candidateTask.status !== "succeeded") {
              await finishTask(
                input.generationPath,
                input.generationId,
                "judge",
                taskTargetId,
                "succeeded",
                input.clock,
                null,
                true,
              );
            }
            const completedAt = candidateTask.completedAt ?? timestamp(input.clock());
            return {
              anonymousCandidateId,
              result: {
                status: "succeeded",
                response: null,
                judgment: durableJudgment,
                usage: durableJudgment.modelUsage,
                rawOutput: null,
                error: null,
                timedOut: false,
                attemptCount: 1,
              },
              durablePath,
              startedAt: candidateTask.startedAt ?? taskStartedAt,
              completedAt,
              durationMs: Math.max(
                0,
                Date.parse(completedAt) -
                  Date.parse(candidateTask.startedAt ?? taskStartedAt),
              ),
            };
          }
          if (TERMINAL_TASK_STATUSES.has(candidateTask.status)) {
            const failedResult = judgeResultFromTask(candidateTask);
            const completedAt = candidateTask.completedAt ?? timestamp(input.clock());
            return {
              anonymousCandidateId,
              result: failedResult,
              durablePath: null,
              startedAt: candidateTask.startedAt ?? taskStartedAt,
              completedAt,
              durationMs: Math.max(
                0,
                Date.parse(completedAt) -
                  Date.parse(candidateTask.startedAt ?? taskStartedAt),
              ),
            };
          }
          if (candidateTask.status === "running") {
            const uncertain = await markTaskUncertain(
              input.generationPath,
              input.generationId,
              "judge",
              taskTargetId,
              input.clock,
              "judge task was running when the generation was resumed; request outcome is uncertain",
            );
            const completedAt = uncertain.completedAt ?? timestamp(input.clock());
            return {
              anonymousCandidateId,
              result: judgeResultFromTask(uncertain),
              durablePath: null,
              startedAt: uncertain.startedAt ?? taskStartedAt,
              completedAt,
              durationMs: Math.max(
                0,
                Date.parse(completedAt) -
                  Date.parse(uncertain.startedAt ?? taskStartedAt),
              ),
            };
          }
          await beginTask(
            input.generationPath,
            input.generationId,
            "judge",
            taskTargetId,
            input.clock,
          );
        }
        const candidateWorkspace = join(judgePath, "workspaces", anonymousCandidateId);
        const rawOutputPath = join(judgePath, "raw", `${anonymousCandidateId}.json`);
        let acceptedResult: JudgeCandidateResult = makeJudgeCandidateFailure(
          "candidate staging did not complete",
        );
        let durablePath: string | null = null;
        let taskCompletedAt = taskStartedAt;
        let taskDurationMs = 0;
        try {
          await mkdir(candidateWorkspace, { recursive: true });
          await stageFile(
            contestant.screenshotPath,
            join(candidateWorkspace, "candidate.png"),
          );
          const sanitisedCssPath = join(
            input.generationPath,
            "contestants",
            contestant.contestantId,
            "sanitised.css",
          );
          if (contestant.validation.sanitisedSha256 === null) {
            throw new Error("valid contestant is missing its sanitised CSS hash");
          }
          await verifyRegularFileHash(
            sanitisedCssPath,
            contestant.validation.sanitisedSha256,
            "durable sanitised CSS",
          );
          await stageFile(sanitisedCssPath, join(candidateWorkspace, "candidate.css"));
          await stageFile(contact.outputPath, join(candidateWorkspace, "cohort.png"));
          const prompt = buildJudgeCandidatePrompt({
            generationId: input.generationId,
            judgeId: input.judge.id,
            anonymousCandidateId,
          });
          const promptPath = join(candidateWorkspace, "prompt.md");
          await writeTextAtomically(promptPath, prompt);
          await writeTextAtomically(
            join(judgePath, "prompts", `${anonymousCandidateId}.md`),
            prompt,
          );
          acceptedResult = await judgeOne(input.adapter, {
            generationId: input.generationId,
            judgeId: input.judge.id,
            anonymousCandidateId,
            judge: input.judge,
            workspacePath: candidateWorkspace,
            promptPath,
            candidateScreenshotPath: join(candidateWorkspace, "candidate.png"),
            contactSheetPath: join(candidateWorkspace, "cohort.png"),
            sanitisedCssPath: join(candidateWorkspace, "candidate.css"),
            judgmentPath: join(candidateWorkspace, "judgment.json"),
            rawOutputPath,
            usageOutputPath: join(candidateWorkspace, "usage.json"),
            stdoutLogPath: join(
              input.generationPath,
              "logs",
              `judge-${input.judge.id}-${anonymousCandidateId}.stdout.log`,
            ),
            stderrLogPath: join(
              input.generationPath,
              "logs",
              `judge-${input.judge.id}-${anonymousCandidateId}.stderr.log`,
            ),
            timeoutMs: budget.timeoutMs,
            maximumOutputTokens: budget.maximumOutputTokens,
          });
          if (acceptedResult.status === "succeeded") {
            if (acceptedResult.judgment === null) {
              acceptedResult = {
                ...acceptedResult,
                status: "invalid",
                response: null,
                judgment: null,
                error: "judge adapter reported success without a durable judgment",
              };
            } else {
              const durable = CandidateJudgmentSchema.parse(acceptedResult.judgment);
              durablePath = join(judgePath, `${anonymousCandidateId}.json`);
              await writeJsonArtifact(durablePath, CandidateJudgmentSchema, durable);
            }
          }
          if (
            acceptedResult.rawOutput !== null ||
            acceptedResult.status !== "succeeded"
          ) {
            await archiveRawOutput(
              rawOutputPath,
              acceptedResult.rawOutput,
              acceptedResult.error,
            );
          }
          if (await regularFileExists(join(candidateWorkspace, "usage.json"))) {
            const usageCopied = await copyDeclaredFile(
              join(candidateWorkspace, "usage.json"),
              join(judgePath, "usage", `${anonymousCandidateId}.json`),
              DEFAULT_USAGE_LIMIT_BYTES,
            );
            if (!usageCopied) {
              throw new Error("candidate usage metadata could not be archived");
            }
          }
        } catch (error) {
          if (durablePath !== null) {
            await rm(durablePath, { force: true }).catch(() => undefined);
            durablePath = null;
          }
          acceptedResult = {
            ...makeJudgeCandidateFailure(error),
            rawOutput: acceptedResult.rawOutput,
            error: `candidate assessment failed: ${boundedError(error)}`,
          };
          await writePrivateFailure(
            rawOutputPath.replace(/\.json$/u, ".failure.txt"),
            acceptedResult.error,
          );
          await archiveRawOutput(
            rawOutputPath,
            acceptedResult.rawOutput,
            acceptedResult.error,
          ).catch(() => undefined);
        } finally {
          await removeWorkspace(candidateWorkspace);
          const taskCompleted = input.clock();
          taskCompletedAt = timestamp(taskCompleted);
          taskDurationMs = Math.max(0, taskCompleted.getTime() - taskStarted.getTime());
        }
        if (input.resumable === true) {
          await finishTask(
            input.generationPath,
            input.generationId,
            "judge",
            taskTargetId,
            judgeTaskStatus(acceptedResult),
            input.clock,
            acceptedResult.error,
            null,
          );
          await notifyTask(input.afterTask, {
            role: "judge",
            targetId: taskTargetId,
            taskId: taskIdentifier(input.generationId, "judge", taskTargetId),
          });
        }
        return {
          anonymousCandidateId,
          result: acceptedResult,
          durablePath,
          startedAt: taskStartedAt,
          completedAt: taskCompletedAt,
          durationMs: taskDurationMs,
        };
      },
    )
    .finally(() => removeWorkspace(join(judgePath, "workspaces")));

  const validJudgmentResults = successfulJudgmentResults(candidateResults);
  const allCandidateAssessmentsValid =
    renderable.length > 0 &&
    candidateResults.length === renderable.length &&
    validJudgmentResults.length === renderable.length;
  if (!allCandidateAssessmentsValid && candidateResults.length > 0) {
    const failedCandidate = candidateResults.find(
      (candidate) => candidate.result.status !== "succeeded",
    );
    judgeFailure =
      failedCandidate === undefined
        ? "candidate assessments were incomplete"
        : `candidate assessment failed: ${boundedError(failedCandidate.result.error ?? "unknown error")}`;
    await writePrivateFailure(join(judgePath, "failure.txt"), judgeFailure);
  }

  let awards: JudgeAwardsResult | null = null;
  let awardsTiming: WaveBTaskTiming | null = null;
  const awardsTaskTargetId = input.judge.id;
  const awardsTask =
    input.resumable === true
      ? await ensurePendingTaskState(
          input.generationPath,
          input.generationId,
          "awards",
          awardsTaskTargetId,
        )
      : null;
  let awardsResolved = false;
  if (!allCandidateAssessmentsValid && awardsTask?.status === "pending") {
    await finishTask(
      input.generationPath,
      input.generationId,
      "awards",
      awardsTaskTargetId,
      "invalid",
      input.clock,
      "awards were not run because candidate assessments were incomplete",
      null,
    );
  }
  if (allCandidateAssessmentsValid && contact !== null) {
    const awardsCandidates = [...validJudgmentResults].sort((left, right) =>
      left.anonymousCandidateId < right.anonymousCandidateId
        ? -1
        : left.anonymousCandidateId > right.anonymousCandidateId
          ? 1
          : 0,
    );
    const summaries = awardsCandidates.map((candidate) => ({
      anonymousCandidateId: candidate.anonymousCandidateId,
      totalScore: candidate.result.judgment!.totalScore,
      originalityScore: candidate.result.judgment!.scores.originalityAndMemorability,
      critique: candidate.result.judgment!.critique,
    }));
    const awardsWorkspace = join(judgePath, "awards-workspace");
    const awardsRawPath = join(judgePath, "raw", "awards.json");
    if (input.resumable === true && awardsTask !== null) {
      let storedAwards: z.infer<typeof GenerationAwardsSchema> | null = null;
      storedAwards = await readReusableAwards(
        input.generationPath,
        input.generationId,
        input.judge.id,
        validJudgmentResults,
      );
      if (storedAwards !== null) {
        if (awardsTask.status !== "succeeded") {
          await finishTask(
            input.generationPath,
            input.generationId,
            "awards",
            awardsTaskTargetId,
            "succeeded",
            input.clock,
            null,
            true,
          );
        }
        awards = {
          status: "succeeded",
          awards: storedAwards,
          rawOutput: null,
          usage: {
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            estimatedCostUsd: null,
          },
          error: null,
          timedOut: false,
          attemptCount: 1,
        };
        const startedAt = awardsTask.startedAt ?? timestamp(input.clock());
        const completedAt = awardsTask.completedAt ?? startedAt;
        awardsTiming = {
          startedAt,
          completedAt,
          durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        };
        awardsResolved = true;
      } else if (TERMINAL_TASK_STATUSES.has(awardsTask.status)) {
        awards = awardsResultFromTask(awardsTask);
        judgeFailure = `awards task failed: ${boundedError(awards.error ?? "unknown error")}`;
        await writePrivateFailure(join(judgePath, "failure.txt"), judgeFailure);
        awardsResolved = true;
      } else if (awardsTask.status === "running") {
        const uncertain = await markTaskUncertain(
          input.generationPath,
          input.generationId,
          "awards",
          awardsTaskTargetId,
          input.clock,
          "awards task was running when the generation was resumed; request outcome is uncertain",
        );
        awards = awardsResultFromTask(uncertain);
        judgeFailure = `awards task failed: ${boundedError(awards.error ?? "unknown error")}`;
        await writePrivateFailure(join(judgePath, "failure.txt"), judgeFailure);
        awardsResolved = true;
      } else {
        await beginTask(
          input.generationPath,
          input.generationId,
          "awards",
          awardsTaskTargetId,
          input.clock,
        );
      }
    }
    if (!awardsResolved) {
      const awardsStarted = input.clock();
      const awardsStartedAt = timestamp(awardsStarted);
      try {
        await writeJsonArtifact(
          join(judgePath, "judgment-summary.json"),
          JudgeSummarySchema,
          {
            schemaVersion: 1,
            generationId: input.generationId,
            judgeId: input.judge.id,
            entries: summaries,
          },
        );
        const awardsPrompt = buildJudgeAwardsPrompt({
          generationId: input.generationId,
          judgeId: input.judge.id,
          summaries,
        });
        await mkdir(awardsWorkspace, { recursive: true });
        await stageFile(contact.outputPath, join(awardsWorkspace, "cohort.png"));
        await stageFile(
          join(judgePath, "judgment-summary.json"),
          join(awardsWorkspace, "judgment-summary.json"),
        );
        await writeTextAtomically(join(awardsWorkspace, "candidate.css"), ":root {}\n");
        const awardsPromptPath = join(awardsWorkspace, "prompt.md");
        await writeTextAtomically(awardsPromptPath, awardsPrompt);
        await writeTextAtomically(join(judgePath, "awards-prompt.md"), awardsPrompt);
        awards = await awardsOne(input.adapter, {
          generationId: input.generationId,
          judgeId: input.judge.id,
          judge: input.judge,
          workspacePath: awardsWorkspace,
          promptPath: awardsPromptPath,
          contactSheetPath: join(awardsWorkspace, "cohort.png"),
          judgmentSummaryPath: join(awardsWorkspace, "judgment-summary.json"),
          awardsPath: join(awardsWorkspace, "awards.json"),
          usageOutputPath: join(awardsWorkspace, "usage.json"),
          rawOutputPath: awardsRawPath,
          stdoutLogPath: join(
            input.generationPath,
            "logs",
            `awards-${input.judge.id}.stdout.log`,
          ),
          stderrLogPath: join(
            input.generationPath,
            "logs",
            `awards-${input.judge.id}.stderr.log`,
          ),
          timeoutMs: budget.timeoutMs,
          maximumOutputTokens: budget.maximumOutputTokens,
          candidates: awardsCandidates.map((candidate) => ({
            anonymousCandidateId: candidate.anonymousCandidateId,
            judgment: candidate.result.judgment,
            sanitisedCssPath: join(awardsWorkspace, "candidate.css"),
          })),
        });
        if (awards.status === "succeeded" && awards.awards === null) {
          awards = {
            ...awards,
            status: "invalid",
            error: "awards adapter reported success without awards data",
          };
        }
        if (awards.status === "succeeded" && awards.awards !== null) {
          const parsedAwards = createGenerationAwardsSchema(
            anonymousCandidateIds(validJudgmentResults),
          ).parse(awards.awards);
          await writeJsonArtifact(
            join(judgePath, "awards.json"),
            GenerationAwardsSchema,
            parsedAwards,
          );
        }
        if (awards.rawOutput !== null || awards.status !== "succeeded") {
          await archiveRawOutput(awardsRawPath, awards.rawOutput, awards.error);
        }
        if (awards.status !== "succeeded") {
          judgeFailure = `awards task failed: ${boundedError(awards.error ?? "unknown error")}`;
          await writePrivateFailure(join(judgePath, "failure.txt"), judgeFailure);
        }
        if (await regularFileExists(join(awardsWorkspace, "usage.json"))) {
          const usageCopied = await copyDeclaredFile(
            join(awardsWorkspace, "usage.json"),
            join(judgePath, "usage", "awards.json"),
            DEFAULT_USAGE_LIMIT_BYTES,
          );
          if (!usageCopied) {
            throw new Error("awards usage metadata could not be archived");
          }
        }
      } catch (error) {
        awards = makeJudgeAdapterFailure(error);
        await rm(join(judgePath, "awards.json"), { force: true }).catch(
          () => undefined,
        );
        judgeFailure = `awards stage failed: ${boundedError(error)}`;
        await writePrivateFailure(join(judgePath, "failure.txt"), judgeFailure);
        await archiveRawOutput(awardsRawPath, null, judgeFailure).catch(
          () => undefined,
        );
      } finally {
        await removeWorkspace(awardsWorkspace);
        const awardsCompleted = input.clock();
        awardsTiming = {
          startedAt: awardsStartedAt,
          completedAt: timestamp(awardsCompleted),
          durationMs: Math.max(0, awardsCompleted.getTime() - awardsStarted.getTime()),
        };
      }
      if (input.resumable === true) {
        if (awards === null) {
          awards = makeJudgeAdapterFailure("awards task did not produce a result");
        }
        await finishTask(
          input.generationPath,
          input.generationId,
          "awards",
          awardsTaskTargetId,
          awardsTaskStatus(awards),
          input.clock,
          awards.error,
          null,
        );
        await notifyTask(input.afterTask, {
          role: "awards",
          targetId: awardsTaskTargetId,
          taskId: taskIdentifier(input.generationId, "awards", awardsTaskTargetId),
        });
      }
    }
  }
  const taskTimingEntries: {
    operation: "candidate" | "awards";
    anonymousCandidateId: string | null;
    startedAt: string;
    completedAt: string;
    durationMs: number;
  }[] = candidateResults.map((candidate) => ({
    operation: "candidate" as const,
    anonymousCandidateId: candidate.anonymousCandidateId,
    startedAt: candidate.startedAt,
    completedAt: candidate.completedAt,
    durationMs: candidate.durationMs,
  }));
  if (awardsTiming !== null) {
    taskTimingEntries.push({
      operation: "awards",
      anonymousCandidateId: null,
      startedAt: awardsTiming.startedAt,
      completedAt: awardsTiming.completedAt,
      durationMs: awardsTiming.durationMs,
    });
  }
  if (taskTimingEntries.length > 0) {
    try {
      await writeJsonArtifact(
        join(judgePath, "task-timings.json"),
        JudgeTaskTimingsSchema,
        {
          schemaVersion: 1,
          generationId: input.generationId,
          judgeId: input.judge.id,
          tasks: taskTimingEntries,
        },
      );
    } catch (error) {
      judgeFailure = `task timing archival failed: ${boundedError(error)}`;
      await writePrivateFailure(join(judgePath, "failure.txt"), judgeFailure);
    }
  }
  return {
    judgeId: input.judge.id,
    path: judgePath,
    contactSheet: contact,
    assessmentOrder,
    assessmentOrderPath,
    candidates: candidateResults,
    awards,
    awardsTiming,
    failure: judgeFailure,
  };
}

async function judgeCandidateNeedsAdapterCall(input: {
  readonly generationPath: string;
  readonly generationId: string;
  readonly judge: JudgeConfig;
  readonly judgePath: string;
  readonly anonymousCandidateId: string;
  readonly contestant: WaveBContestantResult | undefined;
  readonly resumable: boolean;
}): Promise<boolean> {
  if (!input.resumable) return true;
  if (input.contestant === undefined || input.contestant.screenshotPath === null) {
    return false;
  }
  const task = await ensurePendingTaskState(
    input.generationPath,
    input.generationId,
    "judge",
    `${input.judge.id}\0${input.anonymousCandidateId}`,
  );
  if (task.status !== "pending") return false;
  return (
    (await readReusableCandidateJudgment(
      join(input.judgePath, `${input.anonymousCandidateId}.json`),
      input.generationId,
      input.judge.id,
      input.anonymousCandidateId,
    )) === null
  );
}

async function contestantNeedsAdapterCall(input: {
  readonly generationPath: string;
  readonly generationId: string;
  readonly contestant: ContestantConfig;
  readonly resumable: boolean;
}): Promise<boolean> {
  if (!input.resumable) return true;
  const run = await readJsonWithSchema(
    join(input.generationPath, "contestants", input.contestant.id, "run.json"),
    RunSchema,
  );
  const task = await ensurePendingTaskState(
    input.generationPath,
    input.generationId,
    "contestant",
    input.contestant.id,
  );
  return run.status === "pending" && task.status === "pending";
}

async function loadGenerationPath(options: WaveBRunOptions): Promise<string> {
  if (options.generationPath !== undefined) return resolve(options.generationPath);
  if (options.seasonId === undefined)
    throw new Error("seasonId is required when creating a Wave-B generation");
  if (options.profileId === undefined)
    throw new Error("profileId is required when creating a Wave-B generation");
  const created = await createGeneration({
    repositoryRoot: options.repositoryRoot,
    seasonId: options.seasonId,
    profileId: options.profileId,
    ...(options.generationsRoot === undefined
      ? {}
      : { generationsRoot: options.generationsRoot }),
    ...(options.generationId === undefined
      ? {}
      : { generationId: options.generationId }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
    ...(options.acceptPromptOnlyOneShot === true
      ? { acceptPromptOnlyOneShot: true }
      : {}),
  });
  return created.generationPath;
}

export async function runWaveB(options: WaveBRunOptions): Promise<WaveBRunResult> {
  // Combined create-and-run commands must fail before even creating the
  // immutable generation when consent is absent. The post-creation guard below
  // remains authoritative for existing generations and closes any profile
  // change race between this read-only check and generation creation.
  await refuseUnconsentedProfileBeforeCreation(options);
  const generationPath = await loadGenerationPath(options);
  const manifest = await readJsonWithSchema(
    join(generationPath, "manifest.json"),
    ManifestSchema,
  );
  if (options.seasonId !== undefined && manifest.seasonId !== options.seasonId) {
    throw new Error("generation season does not match the requested season");
  }
  if (manifest.status === "completed")
    throw new Error("completed generations are immutable");
  const canonicalState = await loadCanonicalGenerationState(
    generationPath,
    resolve(options.repositoryRoot),
    manifest.configHashes,
  );
  await verifyCanonicalGenerationState(canonicalState);
  const contestantsConfig = await readYamlWithSchema(
    join(generationPath, "config/contestants.yaml"),
    ContestantsConfigSchema,
  );
  const judgesConfig = await readYamlWithSchema(
    join(generationPath, "config/judges.yaml"),
    JudgesConfigSchema,
  );
  const challengeConfig = await readYamlWithSchema(
    join(generationPath, "config/challenge.yaml"),
    ChallengeConfigSchema,
  );
  const contestants = manifest.contestantIds.map((contestantId) => {
    const contestant = contestantsConfig.contestants.find(
      (entry) => entry.id === contestantId && entry.enabled,
    );
    if (contestant === undefined)
      throw new Error(
        `manifest contestant is missing from the enabled roster: ${contestantId}`,
      );
    return contestant;
  });
  const judges = manifest.judgeIds.map((judgeId) => {
    const judge = judgesConfig.judges.find(
      (entry) => entry.id === judgeId && entry.enabled,
    );
    if (judge === undefined)
      throw new Error(`manifest judge is missing from the enabled roster: ${judgeId}`);
    return judge;
  });
  const anonymousMap = await readJsonWithSchema(
    join(generationPath, "judging/anonymous-map.json"),
    AnonymousMapSchema,
  );
  const anonymousByContestant = new Map(
    anonymousMap.entries.map((entry) => [
      entry.contestantId,
      entry.anonymousCandidateId,
    ]),
  );
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const clock = options.clock ?? (() => new Date());
  const operationTimestamp = timestamp(options.now ?? clock());
  const progress = options.onProgress ?? (() => undefined);

  // The paid-call guard. It is config-driven: only enabled command entries in
  // the generation's own copied configuration can make external model calls
  // (injected test adapters do not count). It runs after the canonical state
  // and rosters are loaded and before the first manifest transition or
  // task-state write, so a refusal mutates nothing.
  const commandContestants = contestants.filter(
    (contestant) => contestant.harness.adapter === "command",
  );
  const commandJudges = judges.filter((judge) => judge.harness.adapter === "command");
  const runPlanPath = join(generationPath, "run-plan.json");
  if (
    (await regularFileExists(runPlanPath)) &&
    commandContestants.some(
      (contestant) => contestant.execution?.oneShotEnforcement === "prompt_only",
    )
  ) {
    const runPlan = await readJsonWithSchema(runPlanPath, RunPlanSchema);
    if (!runPlan.promptOnlyOneShotAccepted) {
      throw new Error(
        `generation ${manifest.generationId} refuses command contestants with prompt-only one-shot enforcement: ${runPlan.promptOnlyOneShot.join(", ")}; recreate with --accept-prompt-only-one-shot`,
      );
    }
  }
  if (
    (commandContestants.length > 0 || commandJudges.length > 0) &&
    options.allowModelCalls !== true
  ) {
    const pending = await countPendingCommandCalls(
      generationPath,
      manifest.generationId,
      commandContestants,
      commandJudges,
      contestants,
      anonymousByContestant,
      options.resumable === true,
    );
    const refusal = modelCallRefusalMessage(manifest.generationId, pending);
    if (refusal !== null) throw new Error(refusal);
  }

  const contestantScheduler = new ResourceAwareScheduler({
    globalMaximumConcurrency: Math.min(4, contestantsConfig.defaults.concurrency),
    resourceGroups: contestantsConfig.resourceGroups ?? {},
    ...(options.schedulerTime === undefined ? {} : { time: options.schedulerTime }),
  });

  await updateManifest(generationPath, {
    status: "contestants_running",
    startedAt: manifest.startedAt ?? operationTimestamp,
  });
  const renderer = options.renderer ?? {
    render: (input: Parameters<typeof renderCandidate>[0]) =>
      renderCandidate(input, options.rendererOptions),
  };
  const contactSheetBuilder = options.contactSheetBuilder ?? buildAnonymousContactSheet;
  if (options.resumable === true) {
    await Promise.all(
      contestants.flatMap((contestant) => [
        ensurePendingTaskState(
          generationPath,
          manifest.generationId,
          "contestant",
          contestant.id,
        ),
        ensurePendingTaskState(
          generationPath,
          manifest.generationId,
          "render",
          contestant.id,
        ),
      ]),
    );
    await Promise.all(
      judges.flatMap((judge) => [
        ensurePendingTaskState(
          generationPath,
          manifest.generationId,
          "awards",
          judge.id,
        ),
        ...contestants.map((contestant) => {
          const anonymousCandidateId = anonymousByContestant.get(contestant.id);
          if (anonymousCandidateId === undefined) {
            throw new Error(`anonymous map is missing ${contestant.id}`);
          }
          return ensurePendingTaskState(
            generationPath,
            manifest.generationId,
            "judge",
            `${judge.id}\0${anonymousCandidateId}`,
          );
        }),
      ]),
    );
  }
  const contestantItems = await Promise.all(
    contestants.map(async (contestant) => {
      const needsAdapterCall = await contestantNeedsAdapterCall({
        generationPath,
        generationId: manifest.generationId,
        contestant,
        resumable: options.resumable === true,
      });
      const resourceGroup = contestant.execution?.resourceGroup;
      return needsAdapterCall && resourceGroup !== undefined
        ? { value: contestant, resourceGroup }
        : { value: contestant };
    }),
  );
  const contestantResults = await contestantScheduler.map<
    ContestantConfig,
    WaveBContestantResult
  >(contestantItems, async (contestant) => {
    const anonymousCandidateId = anonymousByContestant.get(contestant.id);
    if (anonymousCandidateId === undefined)
      throw new Error(`anonymous map is missing ${contestant.id}`);
    const adapter =
      options.contestantAdapters?.get(contestant.id) ??
      options.contestantAdapterFactory?.(contestant) ??
      defaultContestantAdapter(options.repositoryRoot, contestant);
    const contestantInput: RunContestantInput = {
      generationPath,
      generationId: manifest.generationId,
      contestant,
      contestantsConfig,
      challengeConfig,
      anonymousCandidateId,
      clock,
      canonicalState,
      adapter,
      renderer,
    };
    return options.resumable === true
      ? runOneContestantResumable({
          ...contestantInput,
          options,
        })
      : runOneContestant(contestantInput);
  });
  const canonicalFailure = contestantResults.find(
    (result) => result.canonicalIntegrityFailed,
  );
  if (canonicalFailure !== undefined) {
    throw new Error(
      `canonical challenge integrity failed after contestant ${canonicalFailure.contestantId}`,
    );
  }
  for (const [index, result] of contestantResults.entries()) {
    progress(
      `[${manifest.generationId}] contestant ${String(index + 1)}/${String(contestants.length)} complete: ${result.anonymousCandidateId} (${result.validation.status})`,
    );
  }
  await updateManifest(generationPath, { status: "contestants_complete" });
  await updateManifest(generationPath, { status: "renders_complete" });
  const judgeResults: WaveBJudgeResult[] = [];
  const judgeScheduler = new ResourceAwareScheduler({
    globalMaximumConcurrency: Math.min(2, judgesConfig.defaults.concurrencyPerJudge),
    resourceGroups: judgesConfig.resourceGroups ?? {},
    ...(options.schedulerTime === undefined ? {} : { time: options.schedulerTime }),
  });
  for (const [index, judge] of judges.entries()) {
    let result: WaveBJudgeResult;
    try {
      const adapter =
        options.judgeAdapters?.get(judge.id) ??
        options.judgeAdapterFactory?.(judge) ??
        defaultJudgeAdapter(judge);
      result = await runOneJudge({
        generationPath,
        generationId: manifest.generationId,
        judge,
        judgeDefaults: judgesConfig.defaults,
        contestants: contestantResults,
        clock,
        randomBytes,
        adapter,
        scheduler: judgeScheduler,
        contactSheetBuilder,
        ...(options.resumable === undefined ? {} : { resumable: options.resumable }),
        ...(options.afterTask === undefined ? {} : { afterTask: options.afterTask }),
      });
    } catch (error) {
      if (error instanceof WaveBInterruptionError) throw error;
      if (options.resumable === true) {
        await markJudgeSetupFailure({
          generationPath,
          generationId: manifest.generationId,
          judgeId: judge.id,
          contestants: contestantResults,
          clock,
          reason: `judge stage failed: ${boundedError(error)}`,
        });
      }
      result = await makeJudgeFailureResult(generationPath, judge.id, error);
    }
    judgeResults.push(result);
    progress(
      `[${manifest.generationId}] judge ${String(index + 1)}/${String(judges.length)} complete`,
    );
  }
  await updateManifest(generationPath, { status: "judging_complete" });
  return {
    generationPath,
    generationId: manifest.generationId,
    contestants: contestantResults,
    judges: judgeResults,
  };
}
