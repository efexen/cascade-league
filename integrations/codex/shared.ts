import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export const MAX_METADATA_BYTES = 16 * 1024;
export const MAX_JUDGE_OUTPUT_BYTES = 128 * 1024;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_CSS_BYTES = 61440;

export const CONTESTANT_DISABLED_FEATURES = [
  "browser_use",
  "browser_use_external",
  "computer_use",
] as const;

const OptionalVersionText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, "must not be blank")
    .nullable();

export const ExecutionMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    observedHarnessVersion: OptionalVersionText(200),
    observedModelVersion: OptionalVersionText(200),
    providerRequestId: OptionalVersionText(256),
  })
  .strict();

export type ExecutionMetadata = Omit<
  z.infer<typeof ExecutionMetadataSchema>,
  "schemaVersion"
>;

export interface CodexCommonInvocation {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sandbox: "workspace-write" | "read-only";
  readonly workspacePath: string;
  readonly outputLastMessagePath: string;
}

function commonCodexArgv(input: CodexCommonInvocation): string[] {
  return [
    "exec",
    "--model",
    input.model,
    "-c",
    `model_reasoning_effort=${input.reasoningEffort}`,
    "--sandbox",
    input.sandbox,
    "-C",
    input.workspacePath,
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    ...CONTESTANT_DISABLED_FEATURES.flatMap((feature) => [
      "-c",
      `features.${feature}=false`,
    ]),
  ];
}

export function buildContestantCodexArgv(
  input: Omit<CodexCommonInvocation, "sandbox">,
): string[] {
  return [
    ...commonCodexArgv({ ...input, sandbox: "workspace-write" }),
    "--output-last-message",
    input.outputLastMessagePath,
    "-",
  ];
}

export interface JudgeCodexInvocation extends CodexCommonInvocation {
  readonly imagePaths: readonly string[];
  readonly outputSchemaPath: string;
}

export function buildJudgeCodexArgv(input: JudgeCodexInvocation): string[] {
  return [
    ...commonCodexArgv(input),
    ...input.imagePaths.flatMap((imagePath) => ["--image", imagePath]),
    "--output-schema",
    input.outputSchemaPath,
    "--output-last-message",
    input.outputLastMessagePath,
    "-",
  ];
}

export function parseOptions(
  argv: readonly string[],
  required: readonly string[],
): Readonly<Record<string, string>> {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || !name.startsWith("--")) {
      throw new Error(`expected a named wrapper option at argv[${String(index)}]`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires one value`);
    }
    if (options[name] !== undefined) {
      throw new Error(`${name} must be supplied only once`);
    }
    options[name] = value;
    index += 1;
  }
  for (const name of required) {
    if (options[name] === undefined || options[name].trim().length === 0) {
      throw new Error(`${name} is required`);
    }
  }
  return options;
}

export function option(
  options: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = options[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function regularFileStatus(path: string, label: string) {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${label} is missing: ${path}`);
    }
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  return status;
}

export async function assertRegularFile(path: string, label: string): Promise<void> {
  await regularFileStatus(path, label);
}

export async function readBoundedText(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<string> {
  const status = await regularFileStatus(path, label);
  if (status.size > maximumBytes) {
    throw new Error(`${label} exceeds the ${String(maximumBytes)}-byte limit`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`${label} exceeds the ${String(maximumBytes)}-byte limit`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

export async function writeTextAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporaryPath, text, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function writeBoundedJson(
  path: string,
  value: unknown,
  maximumBytes = MAX_METADATA_BYTES,
): Promise<void> {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new Error(`JSON output exceeds the ${String(maximumBytes)}-byte limit`);
  }
  await writeTextAtomically(path, text);
}

export function codexEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // The generic command adapter has already applied the profile allowlist to
  // the wrapper. Keep the child boundary narrow as well: OAuth uses HOME,
  // node and codex resolution use PATH, and CODEX_HOME is an optional explicit
  // override. In particular, never pass CODEX_API_KEY through this integration.
  return Object.fromEntries(
    ["HOME", "PATH", "CODEX_HOME"].flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

export interface CodexProcessInput {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly prompt: string;
}

export const MAX_CODEX_STDERR_RETAINED_BYTES = 2048;

function appendBoundedTail(
  current: Buffer,
  chunk: Buffer,
  maximumBytes: number,
): Buffer {
  if (chunk.byteLength >= maximumBytes) {
    return Buffer.from(chunk.subarray(chunk.byteLength - maximumBytes));
  }
  const combined = current.byteLength === 0 ? chunk : Buffer.concat([current, chunk]);
  return combined.byteLength > maximumBytes
    ? Buffer.from(combined.subarray(combined.byteLength - maximumBytes))
    : combined;
}

function codexStderrDiagnostic(captured: Buffer, seenBytes: number): string {
  const collapsed = new TextDecoder("utf-8")
    .decode(captured)
    .replace(/[\p{Cc}]+/gu, " ")
    .trim();
  if (collapsed.length === 0) return JSON.stringify("no stderr output");
  const text =
    seenBytes > captured.byteLength ? `... [truncated] ${collapsed}` : collapsed;
  return JSON.stringify(text);
}

export async function invokeCodex(input: CodexProcessInput): Promise<void> {
  let stderrRetained: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderrSeenBytes = 0;
  const result = await new Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error: string | null;
  }>((resolveResult) => {
    let settled = false;
    const settle = (resultValue: {
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly error: string | null;
    }): void => {
      if (settled) return;
      settled = true;
      resolveResult(resultValue);
    };

    let child;
    try {
      child = spawn(input.executable, [...input.argv], {
        cwd: input.cwd,
        env: codexEnvironment(),
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (error) {
      settle({
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Codex progress is deliberately not copied into the wrapper's output; keep
    // only a bounded stderr tail and drain the pipe so a noisy failed
    // invocation cannot block on stderr.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrSeenBytes += chunk.byteLength;
      stderrRetained = appendBoundedTail(
        stderrRetained,
        chunk,
        MAX_CODEX_STDERR_RETAINED_BYTES,
      );
    });
    child.once("error", (error) => {
      settle({
        exitCode: null,
        signal: null,
        error: error.message,
      });
    });
    child.once("close", (exitCode, signal) => {
      settle({ exitCode, signal, error: null });
    });
    child.stdin?.end(input.prompt);
  });

  if (result.error !== null) {
    throw new Error(`codex invocation failed: ${result.error}`);
  }
  if (result.signal !== null) {
    throw new Error(`codex terminated by ${result.signal}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `codex exited with code ${String(result.exitCode)}; stderr: ${codexStderrDiagnostic(
        stderrRetained,
        stderrSeenBytes,
      )}`,
    );
  }
}

export async function readCodexVersion(executable: string): Promise<string> {
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn(executable, ["--version"], {
      env: codexEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= 4096) chunks.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", rejectOutput);
    child.once("close", (exitCode, signal) => {
      if (signal !== null) {
        rejectOutput(new Error(`codex version probe terminated by ${signal}`));
        return;
      }
      if (exitCode !== 0) {
        rejectOutput(
          new Error(`codex version probe exited with code ${String(exitCode)}`),
        );
        return;
      }
      if (outputBytes > 4096) {
        rejectOutput(new Error("codex version output exceeds the 4096-byte limit"));
        return;
      }
      resolveOutput(
        Buffer.concat([...stdout, ...stderr])
          .toString("utf8")
          .trim(),
      );
    });
  });
  const match =
    /^codex(?:-cli)?\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(output);
  if (match?.[1] === undefined) {
    throw new Error(`unexpected codex version output: ${JSON.stringify(output)}`);
  }
  return match[1];
}

export function isEntrypoint(moduleUrl: string): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(moduleUrl) === invokedPath;
}
