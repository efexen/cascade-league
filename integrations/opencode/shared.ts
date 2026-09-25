import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";

export const MAX_METADATA_BYTES = 16 * 1024;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_CSS_BYTES = 61440;
export const MAX_JUDGE_OUTPUT_BYTES = 128 * 1024;

const OptionalVersionText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0)
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

async function regularFile(path: string, label: string): Promise<void> {
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
}

export async function assertRegularFile(path: string, label: string): Promise<void> {
  await regularFile(path, label);
}

export async function readBoundedText(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<string> {
  await regularFile(path, label);
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

function childEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  includeOpenRouterKey = false,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["HOME", "PATH", ...(includeOpenRouterKey ? ["OPENROUTER_API_KEY"] : [])].flatMap(
      (name) => {
        const value = source[name];
        return value === undefined ? [] : [[name, value]];
      },
    ),
  );
}

export async function readOpenCodeVersion(executable: string): Promise<string> {
  return new Promise((resolveVersion, rejectVersion) => {
    const child = spawn(executable, ["--version"], {
      env: childEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= 4096) chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= 4096) chunks.push(chunk);
    });
    child.once("error", rejectVersion);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        rejectVersion(new Error(`OpenCode version probe terminated by ${signal}`));
      } else if (code !== 0) {
        rejectVersion(
          new Error(`OpenCode version probe exited with code ${String(code)}`),
        );
      } else if (size > 4096) {
        rejectVersion(new Error("OpenCode version output exceeds the 4096-byte limit"));
      } else {
        resolveVersion(Buffer.concat(chunks).toString("utf8").trim());
      }
    });
  });
}

export interface OpenCodeInvocation {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly prompt: string;
  readonly forwardOpenRouterKey?: boolean;
}

export async function invokeOpenCode(input: OpenCodeInvocation): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let child;
    try {
      child = spawn(input.executable, [...input.argv], {
        cwd: input.cwd,
        env: childEnvironment(process.env, input.forwardOpenRouterKey === true),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectOutput(new Error(`OpenCode invocation failed: ${String(error)}`));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) =>
      rejectOutput(new Error(`OpenCode invocation failed: ${error.message}`)),
    );
    child.once("close", (code, signal) => {
      if (signal !== null) {
        rejectOutput(new Error(`OpenCode terminated by ${signal}`));
      } else if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim().slice(-2048);
        rejectOutput(
          new Error(
            `OpenCode exited with code ${String(code)}${diagnostic ? `; stderr: ${diagnostic}` : ""}`,
          ),
        );
      } else {
        resolveOutput(Buffer.concat(stdout).toString("utf8"));
      }
    });
  });
}

function balancedJsonAt(text: string, start: number): string | null {
  const opening = text[start];
  if (opening !== "{" && opening !== "[") return null;
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function extractLastJsonValue(output: string): string {
  const eventTexts: string[] = [];
  const lines = output.split(/\r?\n/u);
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as unknown;
      if (event !== null && typeof event === "object") {
        const texts: string[] = [];
        const visit = (value: unknown): void => {
          if (value === null || typeof value !== "object") return;
          if (Array.isArray(value)) {
            value.forEach(visit);
            return;
          }
          for (const [key, child] of Object.entries(value)) {
            if (key === "text" && typeof child === "string") texts.push(child);
            visit(child);
          }
        };
        visit(event);
        eventTexts.push(...texts);
      }
    } catch {
      // Human diagnostic lines are ignored; JSON text events are handled above.
    }
  }
  for (const text of eventTexts.reverse()) {
    const trimmed = text.trim();
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === "object") return trimmed;
    } catch {
      const extracted = extractLastJsonValue(text);
      if (extracted.length > 0) return extracted;
    }
  }
  let lastCandidate: { readonly json: string; readonly end: number } | null = null;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") continue;
    const candidate = balancedJsonAt(output, index);
    if (candidate !== null) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          const end = index + candidate.length;
          if (lastCandidate === null || end > lastCandidate.end) {
            lastCandidate = { json: candidate, end };
          }
        }
      } catch {
        // A larger enclosing value may be valid even when an inner fragment is not.
      }
    }
  }
  if (lastCandidate === null)
    throw new Error("OpenCode output contained no JSON object");
  return lastCandidate.json;
}

export function isEntrypoint(moduleUrl: string): boolean {
  return (
    process.argv[1] !== undefined &&
    new URL(`file://${process.argv[1]}`).href === moduleUrl
  );
}

export function parseOptions(argv: readonly string[], required: readonly string[]) {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      name === undefined ||
      !name.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(`invalid wrapper option at argv[${String(index)}]`);
    }
    if (values[name] !== undefined)
      throw new Error(`${name} must be supplied only once`);
    values[name] = value;
  }
  required.forEach((name) => {
    if (values[name] === undefined || values[name].trim().length === 0)
      throw new Error(`${name} is required`);
  });
  return values;
}

export function option(values: Readonly<Record<string, string>>, name: string): string {
  const value = values[name];
  if (value === undefined || value.trim().length === 0)
    throw new Error(`${name} is required`);
  return value;
}

export function optionalOption(
  values: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return values[name];
}
