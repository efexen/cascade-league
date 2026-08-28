import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { createGeneration } from "../artifacts/generation.js";
import {
  buildContestantGenerationOnePrompt,
  buildJudgeAwardsPrompt,
  buildJudgeCandidatePrompt,
} from "../prompts/index.js";
import {
  CandidateJudgmentSchema,
  ChallengeConfigSchema,
  ContestantsConfigSchema,
  createGenerationAwardsSchema,
  GenerationAwardsSchema,
  JudgeAssessmentOrderSchema,
  JudgeSummarySchema,
  JudgeTaskTimingsSchema,
  JudgesConfigSchema,
  AnonymousMapSchema,
  ManifestSchema,
  RunSchema,
  SnapshotSchema,
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
  type Run,
  type Snapshot,
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

export interface WaveBRunOptions {
  readonly repositoryRoot: string;
  readonly seasonId?: string;
  readonly generationPath?: string;
  readonly generationsRoot?: string;
  readonly generationId?: string;
  readonly now?: string | Date;
  readonly clock?: () => Date;
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
  readonly onProgress?: (message: string) => void;
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
  return {
    generationPath,
    repositoryRoot,
    snapshot,
    snapshotHash: await sha256File(snapshotPath),
    configHashes,
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
    contestants: "config/contestants.yaml",
    judges: "config/judges.yaml",
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
    const sourcePath = resolve(state.repositoryRoot, provenancePath);
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
    (relativePath) => relativePath !== "fallback.css",
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

async function mapConcurrent<T, R>(
  values: readonly T[],
  requestedConcurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const concurrency = Math.max(
    1,
    Math.min(values.length, Math.floor(requestedConcurrency)),
  );
  const results: R[] = new Array(values.length);
  const errors: { readonly index: number; readonly error: unknown }[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index]!, index);
      } catch (error) {
        errors.push({ index, error });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (errors.length > 0) {
    errors.sort((left, right) => left.index - right.index);
    throw errors[0]!.error;
  }
  return results;
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

async function runOneContestant(input: {
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
}): Promise<WaveBContestantResult> {
  const contestantPath = join(input.generationPath, "contestants", input.contestant.id);
  const workspacePath = join(contestantPath, "workspace");
  const runPath = join(contestantPath, "run.json");
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
  const started = input.clock();
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

async function runOneJudge(input: {
  readonly generationPath: string;
  readonly generationId: string;
  readonly judge: JudgeConfig;
  readonly judgeDefaults: JudgesConfig["defaults"];
  readonly contestants: readonly WaveBContestantResult[];
  readonly clock: () => Date;
  readonly randomBytes: (size: number) => Buffer;
  readonly adapter: JudgeAdapter;
  readonly contactSheetBuilder: (
    input: Parameters<typeof buildAnonymousContactSheet>[0],
  ) => Promise<AnonymousContactSheetResult>;
}): Promise<WaveBJudgeResult> {
  const judgePath = join(input.generationPath, "judging", input.judge.id);
  let contact: AnonymousContactSheetResult | null = null;
  let judgeFailure: string | null = null;
  try {
    await mkdir(judgePath, { recursive: true });
    await removeWorkspace(join(judgePath, "workspaces"));
    await removeWorkspace(join(judgePath, "awards-workspace"));
    contact = await input.contactSheetBuilder({
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
    });
  } catch (error) {
    judgeFailure = `contact-sheet setup failed: ${boundedError(error)}`;
    await rm(join(judgePath, "contact-sheet.png"), { force: true }).catch(
      () => undefined,
    );
    await rm(join(judgePath, "contact-sheet-order.json"), { force: true }).catch(
      () => undefined,
    );
    await writePrivateFailure(join(judgePath, "failure.txt"), judgeFailure);
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

  const renderable = input.contestants.filter(
    (contestant) =>
      contestant.validation.status === "valid" &&
      contestant.screenshotPath !== null &&
      contestant.run.status === "succeeded",
  );
  const executionOrder = renderable.map(
    (contestant) => contestant.anonymousCandidateId,
  );
  const assessmentSeed = domainSeparatedJudgeSeed(
    input.randomBytes,
    input.generationId,
    input.judge.id,
    "assessment",
  );
  const contactRenderableOrder = contact.candidateOrder.filter((candidateId) =>
    executionOrder.includes(candidateId),
  );
  const assessmentOrder = independentOrder(
    assessmentSeed,
    executionOrder,
    executionOrder,
    contactRenderableOrder,
  );
  const assessmentOrderPath =
    renderable.length === 0 ? null : join(judgePath, "assessment-order.json");
  try {
    if (assessmentOrderPath !== null) {
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
  const candidateResults = await mapConcurrent(
    assessmentOrder,
    Math.min(2, input.judgeDefaults.concurrencyPerJudge),
    async (anonymousCandidateId): Promise<WaveBJudgeCandidateResult> => {
      const taskStarted = input.clock();
      const taskStartedAt = timestamp(taskStarted);
      const contestant = contestantsByAnonymousId.get(anonymousCandidateId);
      if (contestant === undefined || contestant.screenshotPath === null) {
        const taskCompleted = input.clock();
        return {
          anonymousCandidateId,
          result: makeJudgeCandidateFailure("candidate is not renderable"),
          durablePath: null,
          startedAt: taskStartedAt,
          completedAt: timestamp(taskCompleted),
          durationMs: Math.max(0, taskCompleted.getTime() - taskStarted.getTime()),
        };
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
      return {
        anonymousCandidateId,
        result: acceptedResult,
        durablePath,
        startedAt: taskStartedAt,
        completedAt: taskCompletedAt,
        durationMs: taskDurationMs,
      };
    },
  ).finally(() => removeWorkspace(join(judgePath, "workspaces")));

  const validJudgmentResults = candidateResults.filter(
    (candidate) =>
      candidate.result.status === "succeeded" && candidate.result.judgment !== null,
  );
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
          validJudgmentResults.map((candidate) => candidate.anonymousCandidateId),
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
      await rm(join(judgePath, "awards.json"), { force: true }).catch(() => undefined);
      judgeFailure = `awards stage failed: ${boundedError(error)}`;
      await writePrivateFailure(join(judgePath, "failure.txt"), judgeFailure);
      await archiveRawOutput(awardsRawPath, null, judgeFailure).catch(() => undefined);
    } finally {
      await removeWorkspace(awardsWorkspace);
      const awardsCompleted = input.clock();
      awardsTiming = {
        startedAt: awardsStartedAt,
        completedAt: timestamp(awardsCompleted),
        durationMs: Math.max(0, awardsCompleted.getTime() - awardsStarted.getTime()),
      };
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

async function loadGenerationPath(options: WaveBRunOptions): Promise<string> {
  if (options.generationPath !== undefined) return resolve(options.generationPath);
  if (options.seasonId === undefined)
    throw new Error("seasonId is required when creating a Wave-B generation");
  const created = await createGeneration({
    repositoryRoot: options.repositoryRoot,
    seasonId: options.seasonId,
    ...(options.generationsRoot === undefined
      ? {}
      : { generationsRoot: options.generationsRoot }),
    ...(options.generationId === undefined
      ? {}
      : { generationId: options.generationId }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
  });
  return created.generationPath;
}

export async function runWaveB(options: WaveBRunOptions): Promise<WaveBRunResult> {
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
  await updateManifest(generationPath, {
    status: "contestants_running",
    startedAt: manifest.startedAt ?? operationTimestamp,
  });
  const renderer = options.renderer ?? {
    render: (input: Parameters<typeof renderCandidate>[0]) =>
      renderCandidate(input, options.rendererOptions),
  };
  const contactSheetBuilder = options.contactSheetBuilder ?? buildAnonymousContactSheet;
  const contestantResults = await mapConcurrent(
    contestants,
    Math.min(4, contestantsConfig.defaults.concurrency),
    async (contestant) => {
      const anonymousCandidateId = anonymousByContestant.get(contestant.id);
      if (anonymousCandidateId === undefined)
        throw new Error(`anonymous map is missing ${contestant.id}`);
      const adapter =
        options.contestantAdapters?.get(contestant.id) ??
        options.contestantAdapterFactory?.(contestant) ??
        defaultContestantAdapter(options.repositoryRoot, contestant);
      const result = await runOneContestant({
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
      });
      return result;
    },
  );
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
        contactSheetBuilder,
      });
    } catch (error) {
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
