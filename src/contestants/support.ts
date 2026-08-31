import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { z } from "zod";

import type { ContestantRunResult, ContestantRunUsage } from "./types.js";

export const DEFAULT_LOG_LIMIT_BYTES = 128 * 1024;
export const DEFAULT_TERMINATION_GRACE_MS = 250;
export const DEFAULT_TERMINATION_COMPLETION_GRACE_MS = 250;
export const DEFAULT_USAGE_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_EXECUTION_METADATA_LIMIT_BYTES = 16 * 1024;
export const DEFAULT_JUDGE_OUTPUT_LIMIT_BYTES = 128 * 1024;
export const NOT_RECORDED_VERSION = "not-recorded";

const UsageFileSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable().optional(),
    outputTokens: z.number().int().nonnegative().nullable().optional(),
    reasoningTokens: z.number().int().nonnegative().nullable().optional(),
    totalTokens: z.number().int().nonnegative().nullable().optional(),
    estimatedCostUsd: z.number().nonnegative().nullable().optional(),
    tokenLimitEnforced: z.boolean().optional(),
  })
  .strict();

const OptionalVersionText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, "must not be blank")
    .nullable();

// The optional, private `execution-metadata.json` a harness wrapper may write
// beside its usage file. It records what the harness actually observed at run
// time (never the configured identity) plus a private provider request id.
export const ExecutionMetadataFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    observedHarnessVersion: OptionalVersionText(200),
    observedModelVersion: OptionalVersionText(200),
    providerRequestId: OptionalVersionText(256),
  })
  .strict();

export interface ExecutionMetadata {
  readonly observedHarnessVersion: string | null;
  readonly observedModelVersion: string | null;
  readonly providerRequestId: string | null;
}

export const emptyExecutionMetadata = (): ExecutionMetadata => ({
  observedHarnessVersion: null,
  observedModelVersion: null,
  providerRequestId: null,
});

export type BoundedFileReadResult =
  | { readonly kind: "missing"; readonly size: 0 }
  | { readonly kind: "invalid"; readonly size: number }
  | { readonly kind: "too_large"; readonly size: number }
  | { readonly kind: "ok"; readonly size: number; readonly bytes: Buffer };

export async function readRegularFileAtMost(
  path: string,
  maximumBytes: number,
): Promise<BoundedFileReadResult> {
  const limit = Math.max(0, Math.floor(maximumBytes));
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { kind: "missing", size: 0 };
    }
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    return { kind: "invalid", size: status.size };
  }
  if (!Number.isSafeInteger(status.size) || status.size > limit) {
    return { kind: "too_large", size: status.size };
  }

  const readLimit = limit + 1;
  const chunks: Buffer[] = [];
  let total = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    while (total < readLimit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - total));
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      total += result.bytesRead;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (total > limit) return { kind: "too_large", size: total };
  return { kind: "ok", size: total, bytes: Buffer.concat(chunks, total) };
}

export const emptyUsage = (tokenLimitEnforced = false): ContestantRunUsage => ({
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null,
  estimatedCostUsd: null,
  tokenLimitEnforced,
});

export async function writeTextAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, text, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function redactSecrets(
  text: string,
  secretValues: readonly string[] | undefined,
): string {
  const values = [
    ...new Set((secretValues ?? []).filter((value) => value.length > 0)),
  ].sort((left, right) => right.length - left.length);
  return values.reduce(
    (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
    text,
  );
}

function redactBoundaryFragments(
  text: string,
  secretValues: readonly string[] | undefined,
): string {
  const values = [
    ...new Set((secretValues ?? []).filter((value) => value.length > 1)),
  ].sort((left, right) => right.length - left.length);
  return values.reduce((safe, secret) => {
    for (let length = secret.length - 1; length > 0; length -= 1) {
      const fragment = secret.slice(0, length);
      if (safe.endsWith(fragment)) {
        return `${safe.slice(0, -fragment.length)}[REDACTED]`;
      }
    }
    return safe;
  }, text);
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const limit = Math.max(0, Math.floor(maximumBytes));
  if (limit === 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limit) return value;
  for (let end = limit; end > 0; end -= 1) {
    const prefix = bytes.subarray(0, end).toString("utf8");
    if (Buffer.byteLength(prefix, "utf8") <= limit) return prefix;
  }
  return "";
}

function truncatedUtf8(
  value: string,
  maximumBytes: number,
  secretValues: readonly string[] | undefined,
): string {
  const limit = Math.max(0, Math.floor(maximumBytes));
  if (limit === 0) return "";
  const marker = redactBoundaryFragments(
    redactSecrets("\n[output truncated]", secretValues),
    secretValues,
  );
  if (Buffer.byteLength(marker, "utf8") >= limit) {
    return utf8Prefix(marker, limit);
  }
  const prefix = utf8Prefix(value, limit - Buffer.byteLength(marker, "utf8"));
  return `${prefix}${marker}`;
}

export function boundedUtf8(
  chunks: readonly Buffer[],
  maximumBytes: number,
  secretValues?: readonly string[],
): string {
  const value = Buffer.concat(chunks).toString("utf8");
  const redacted = redactBoundaryFragments(
    redactSecrets(value, secretValues),
    secretValues,
  );
  const limit = Math.max(0, Math.floor(maximumBytes));
  if (
    Buffer.byteLength(value, "utf8") <= limit &&
    Buffer.byteLength(redacted, "utf8") <= limit
  ) {
    return redacted;
  }
  return truncatedUtf8(redacted, limit, secretValues);
}

function secretLookaheadBytes(secretValues: readonly string[] | undefined): number {
  return Math.max(
    0,
    ...(secretValues ?? []).map((value) => Buffer.byteLength(value, "utf8")),
  );
}

export function appendBoundedChunk(
  chunks: Buffer[],
  capturedBytes: number,
  chunk: Buffer | string,
  maximumBytes: number,
  lookaheadBytes = 0,
): number {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const captureLimit =
    Math.max(0, Math.floor(maximumBytes)) + Math.max(0, Math.floor(lookaheadBytes)) + 1;
  if (capturedBytes < captureLimit) {
    chunks.push(bytes.subarray(0, captureLimit - capturedBytes));
  }
  return capturedBytes + bytes.byteLength;
}

export async function writeLog(
  path: string,
  chunks: readonly Buffer[],
  secretValues: readonly string[] | undefined,
  maximumBytes = DEFAULT_LOG_LIMIT_BYTES,
): Promise<void> {
  await writeTextAtomically(path, boundedUtf8(chunks, maximumBytes, secretValues));
}

export interface CommandSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly detached: boolean;
  readonly stdio: ["ignore", "pipe", "pipe"];
}

export type CommandSpawnProcess = (
  executable: string,
  arguments_: readonly string[],
  options: CommandSpawnOptions,
) => ChildProcess;

export interface BoundedCommandInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly maximumLogBytes: number;
  readonly redactionValues?: readonly string[];
  readonly stdoutLogPath: string;
  readonly stderrLogPath: string;
  readonly spawnProcess?: CommandSpawnProcess;
  /** Injected process doubles deliberately use direct-child fallback by default. */
  readonly useProcessGroup?: boolean;
}

export interface BoundedCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly terminationSignals: readonly ("SIGTERM" | "SIGKILL")[];
  readonly stdout: readonly Buffer[];
  readonly stderr: readonly Buffer[];
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSafeProcessGroupLeader(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 1;
}

function killChildOrGroup(
  child: ChildProcess,
  signal: "SIGTERM" | "SIGKILL",
  useProcessGroup: boolean,
): string | null {
  if (useProcessGroup && isSafeProcessGroupLeader(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return null;
    } catch (error) {
      // ESRCH means the group has already gone. For all other failures, retain
      // the direct-child fallback so injected/mocked process implementations
      // remain safe and useful.
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return null;
      }
    }
  }
  try {
    child.kill(signal);
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

function destroyCapturedStreams(child: ChildProcess): void {
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
}

export async function runBoundedCommand(
  input: BoundedCommandInput,
): Promise<BoundedCommandResult> {
  const redactionValues = input.redactionValues ?? [];
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const lookaheadBytes = secretLookaheadBytes(redactionValues);
  const spawnProcess = input.spawnProcess ?? nodeSpawn;
  const useProcessGroup =
    input.useProcessGroup ??
    (input.spawnProcess === undefined && process.platform === "darwin");
  const terminationSignals: ("SIGTERM" | "SIGKILL")[] = [];
  const maximumLogBytes = Math.max(0, Math.floor(input.maximumLogBytes));
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let child: ChildProcess | null = null;
  let timedOut = false;
  let processClosed = false;
  let settled = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let completionTimer: NodeJS.Timeout | undefined;
  let settlePromise:
    | ((result: {
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
        readonly error: string | null;
      }) => void)
    | undefined;

  const closed = new Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error: string | null;
  }>((resolvePromise) => {
    settlePromise = resolvePromise;
  });

  const settle = (result: {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error: string | null;
  }): void => {
    if (settled) return;
    settled = true;
    settlePromise?.(result);
  };

  let onStdout: ((chunk: Buffer | string) => void) | undefined;
  let onStderr: ((chunk: Buffer | string) => void) | undefined;
  let onClose:
    | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)
    | undefined;
  let onError: ((error: Error) => void) | undefined;

  try {
    const executable = input.argv[0];
    if (executable === undefined) {
      throw new Error("command executable is missing");
    }
    child = spawnProcess(executable, input.argv.slice(1), {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onStdout = (chunk) => {
      stdoutBytes = appendBoundedChunk(
        stdout,
        stdoutBytes,
        chunk,
        maximumLogBytes,
        lookaheadBytes,
      );
    };
    onStderr = (chunk) => {
      stderrBytes = appendBoundedChunk(
        stderr,
        stderrBytes,
        chunk,
        maximumLogBytes,
        lookaheadBytes,
      );
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    onClose = (exitCode, signal) => {
      processClosed = true;
      settle({ exitCode, signal, error: null });
    };
    onError = (error) => {
      if (processClosed) return;
      const signal = timedOut ? "SIGKILL" : "SIGTERM";
      terminationSignals.push(signal);
      processClosed = true;
      const killError = killChildOrGroup(child!, signal, useProcessGroup);
      destroyCapturedStreams(child!);
      settle({
        exitCode: null,
        signal: null,
        error:
          killError === null
            ? redactSecrets(errorMessage(error), redactionValues)
            : redactSecrets(
                `${errorMessage(error)}; failed to send ${signal}: ${killError}`,
                redactionValues,
              ),
      });
    };
    child.once("close", onClose);
    child.once("error", onError);

    const terminate = (signal: "SIGTERM" | "SIGKILL"): void => {
      if (child === null || processClosed) return;
      terminationSignals.push(signal);
      const killError = killChildOrGroup(child, signal, useProcessGroup);
      if (killError !== null) {
        settle({
          exitCode: null,
          signal,
          error: redactSecrets(
            `failed to send ${signal}: ${killError}`,
            redactionValues,
          ),
        });
      }
    };

    timeoutTimer = setTimeout(
      () => {
        if (settled) return;
        timedOut = true;
        terminate("SIGTERM");
        forceKillTimer = setTimeout(
          () => {
            if (settled) return;
            terminate("SIGKILL");
            completionTimer = setTimeout(() => {
              if (settled) return;
              // A descendant can keep inherited pipes open after the process group
              // is gone. Destroy local streams and settle without waiting for close.
              destroyCapturedStreams(child!);
              settle({
                exitCode: null,
                signal: "SIGKILL",
                error: "command did not close after forced termination",
              });
            }, DEFAULT_TERMINATION_COMPLETION_GRACE_MS);
          },
          Math.max(0, Math.floor(input.terminationGraceMs)),
        );
      },
      Math.max(0, Math.floor(input.timeoutMs)),
    );

    const result = await closed;
    return {
      ...result,
      timedOut,
      terminationSignals,
      stdout,
      stderr,
    };
  } catch (error) {
    settle({
      exitCode: null,
      signal: null,
      error: redactSecrets(errorMessage(error), redactionValues),
    });
    const result = await closed;
    return {
      ...result,
      timedOut,
      terminationSignals,
      stdout,
      stderr,
    };
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    if (completionTimer !== undefined) clearTimeout(completionTimer);
    if (child !== null) {
      if (onStdout !== undefined) child.stdout?.removeListener("data", onStdout);
      if (onStderr !== undefined) child.stderr?.removeListener("data", onStderr);
      if (onClose !== undefined) child.removeListener("close", onClose);
      if (onError !== undefined) child.removeListener("error", onError);
    }
    await writeLog(input.stdoutLogPath, stdout, redactionValues, maximumLogBytes);
    await writeLog(input.stderrLogPath, stderr, redactionValues, maximumLogBytes);
  }
}

export async function regularFileExists(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    return status.isFile() && !status.isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readUsageFile(
  path: string,
  tokenLimitEnforced = false,
): Promise<{ usage: ContestantRunUsage; exists: boolean; error: string | null }> {
  if (!(await regularFileExists(path))) {
    return { usage: emptyUsage(tokenLimitEnforced), exists: false, error: null };
  }
  const file = await readRegularFileAtMost(path, DEFAULT_USAGE_LIMIT_BYTES);
  if (file.kind === "too_large") {
    return {
      usage: emptyUsage(tokenLimitEnforced),
      exists: true,
      error: `usage metadata exceeds the ${DEFAULT_USAGE_LIMIT_BYTES}-byte limit`,
    };
  }
  if (file.kind !== "ok") {
    return {
      usage: emptyUsage(tokenLimitEnforced),
      exists: true,
      error: "usage metadata is not a regular file",
    };
  }
  try {
    const parsed = UsageFileSchema.parse(
      JSON.parse(file.bytes.toString("utf8")) as unknown,
    );
    return {
      exists: true,
      error: null,
      usage: {
        inputTokens: parsed.inputTokens ?? null,
        outputTokens: parsed.outputTokens ?? null,
        reasoningTokens: parsed.reasoningTokens ?? null,
        totalTokens: parsed.totalTokens ?? null,
        estimatedCostUsd: parsed.estimatedCostUsd ?? null,
        tokenLimitEnforced: parsed.tokenLimitEnforced ?? tokenLimitEnforced,
      },
    };
  } catch (error) {
    return {
      exists: true,
      usage: emptyUsage(tokenLimitEnforced),
      error: `usage metadata was invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function readExecutionMetadataFile(path: string): Promise<{
  metadata: ExecutionMetadata;
  exists: boolean;
  error: string | null;
}> {
  const file = await readRegularFileAtMost(
    path,
    DEFAULT_EXECUTION_METADATA_LIMIT_BYTES,
  );
  if (file.kind === "missing") {
    return { metadata: emptyExecutionMetadata(), exists: false, error: null };
  }
  if (file.kind === "too_large") {
    return {
      metadata: emptyExecutionMetadata(),
      exists: true,
      error: `execution metadata exceeds the ${DEFAULT_EXECUTION_METADATA_LIMIT_BYTES}-byte limit`,
    };
  }
  if (file.kind !== "ok") {
    return {
      metadata: emptyExecutionMetadata(),
      exists: true,
      error: "execution metadata is not a regular file",
    };
  }
  try {
    const parsed = ExecutionMetadataFileSchema.parse(
      JSON.parse(file.bytes.toString("utf8")) as unknown,
    );
    return {
      exists: true,
      error: null,
      metadata: {
        observedHarnessVersion: parsed.observedHarnessVersion,
        observedModelVersion: parsed.observedModelVersion,
        providerRequestId: parsed.providerRequestId,
      },
    };
  } catch (error) {
    return {
      exists: true,
      metadata: emptyExecutionMetadata(),
      error: `execution metadata was invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function resultWithError(
  result: Omit<ContestantRunResult, "error">,
  error: string | null,
): ContestantRunResult {
  return { ...result, error };
}
