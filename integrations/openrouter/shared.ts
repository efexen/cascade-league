import { lstat, open } from "node:fs/promises";
import { z } from "zod";

import {
  MAX_CSS_BYTES,
  MAX_JUDGE_OUTPUT_BYTES,
  MAX_METADATA_BYTES,
  MAX_PROMPT_BYTES,
  ExecutionMetadataSchema,
  assertRegularFile,
  extractLastJsonValue,
  option,
  parseOptions,
  isEntrypoint,
  writeBoundedJson,
  writeTextAtomically,
} from "../opencode/shared.js";

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_REQUEST_TIMEOUT_MS = 600_000;

export function parseRequestTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `--request-timeout-ms must be a positive safe integer no greater than ${MAX_REQUEST_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

export {
  MAX_CSS_BYTES,
  MAX_JUDGE_OUTPUT_BYTES,
  MAX_METADATA_BYTES,
  MAX_PROMPT_BYTES,
  assertRegularFile,
  option,
  parseOptions,
  isEntrypoint,
  writeBoundedJson,
  writeTextAtomically,
};

export async function readBoundedText(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`${label} must be a regular file: ${path}`);
  if (info.size > maximumBytes)
    throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(maximumBytes + 1);
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0));
  } finally {
    await handle.close();
  }
  if (bytesRead > maximumBytes)
    throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

export const CompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.unknown()).min(1),
    max_completion_tokens: z.number().int().positive(),
    stream: z.literal(false),
    provider: z.object({ allow_fallbacks: z.literal(false) }).strict(),
  })
  .strict();

export interface OpenRouterUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly tokenLimitEnforced: false;
}

export interface CompletionResult {
  readonly content: string;
  readonly requestId: string | null;
  readonly model: string | null;
  readonly usage: OpenRouterUsage;
}

function boundedInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function boundedCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

async function readResponseBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("OpenRouter response exceeds the response byte limit");
  }
  if (response.body === null) throw new Error("OpenRouter response body is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("OpenRouter response exceeds the response byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function usageFrom(value: unknown): OpenRouterUsage {
  const usage = typeof value === "object" && value !== null ? value : {};
  const row = usage as Record<string, unknown>;
  const completionDetails =
    typeof row.completion_tokens_details === "object" &&
    row.completion_tokens_details !== null
      ? (row.completion_tokens_details as Record<string, unknown>)
      : {};
  return {
    inputTokens: boundedInteger(row.prompt_tokens),
    outputTokens: boundedInteger(row.completion_tokens),
    reasoningTokens: boundedInteger(
      completionDetails.reasoning_tokens ?? row.reasoning_tokens,
    ),
    totalTokens: boundedInteger(row.total_tokens),
    estimatedCostUsd: boundedCost(row.cost),
    tokenLimitEnforced: false,
  };
}

function diagnosticFinishReason(value: unknown): string {
  const knownReasons = new Set(["stop", "length", "content_filter", "tool_calls"]);
  if (typeof value !== "string") return "[invalid]";
  if (knownReasons.has(value)) return value;
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "[invalid]";
}

function nonStopDiagnostic(
  root: Record<string, unknown>,
  choice: Record<string, unknown>,
): string {
  const usage = usageFrom(root.usage);
  const details = [
    `finish_reason=${diagnosticFinishReason(choice.finish_reason)}`,
    `completion_tokens=${usage.outputTokens ?? "unknown"}`,
    `reasoning_tokens=${usage.reasoningTokens ?? "unknown"}`,
  ];
  if (typeof root.id === "string" && root.id.length <= 256)
    details.push(`request_id=${JSON.stringify(root.id)}`);
  return details.join(", ");
}

export async function requestCompletion(
  input: {
    readonly apiKey: string;
    readonly model: string;
    readonly maxCompletionTokens: number;
    readonly content: string | readonly unknown[];
    readonly timeoutMs?: number;
  },
  options: { readonly endpoint?: string; readonly fetchImpl?: typeof fetch } = {},
): Promise<CompletionResult> {
  if (!input.apiKey.trim()) throw new Error("OPENROUTER_API_KEY is required");
  const timeoutMs = input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `request timeout must be a positive safe integer no greater than ${MAX_REQUEST_TIMEOUT_MS}`,
    );
  }
  const endpoint = options.endpoint ?? OPENROUTER_ENDPOINT;
  if (endpoint !== OPENROUTER_ENDPOINT) {
    const url = new URL(endpoint);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) {
      throw new Error("injected OpenRouter endpoint must use loopback HTTP");
    }
  }
  const body = CompletionRequestSchema.parse({
    model: input.model,
    messages: [{ role: "user", content: input.content }],
    max_completion_tokens: input.maxCompletionTokens,
    stream: false,
    provider: { allow_fallbacks: false },
  });
  const serializedBody = JSON.stringify(body);
  if (Buffer.byteLength(serializedBody, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("OpenRouter request exceeds the request byte limit");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body: serializedBody,
        signal: controller.signal,
      });
    } catch {
      throw new Error(
        controller.signal.aborted
          ? "OpenRouter request timed out"
          : "OpenRouter request failed",
      );
    }
    if (!response.ok) {
      // Deliberately do not read provider error bodies: they may echo secrets or prompt data.
      throw new Error(`OpenRouter returned HTTP ${response.status}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(await readResponseBody(response)) as unknown;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("OpenRouter request timed out");
      if (error instanceof Error && error.message.includes("byte limit")) throw error;
      throw new Error("OpenRouter returned malformed JSON");
    }
    if (typeof data !== "object" || data === null)
      throw new Error("OpenRouter response has an invalid shape");
    const root = data as Record<string, unknown>;
    const choices = root.choices;
    if (
      !Array.isArray(choices) ||
      choices.length !== 1 ||
      typeof choices[0] !== "object" ||
      choices[0] === null
    ) {
      throw new Error("OpenRouter response must contain exactly one choice");
    }
    const choice = choices[0] as Record<string, unknown>;
    if (choice.finish_reason !== "stop")
      throw new Error(
        `OpenRouter completion was not finished normally (${nonStopDiagnostic(root, choice)})`,
      );
    const message = choice.message;
    if (
      typeof message !== "object" ||
      message === null ||
      typeof (message as Record<string, unknown>).content !== "string"
    ) {
      throw new Error("OpenRouter response content is empty or malformed");
    }
    const content = ((message as Record<string, unknown>).content as string).trim();
    if (!content) throw new Error("OpenRouter response content is empty or malformed");
    return {
      content,
      requestId: typeof root.id === "string" && root.id.length <= 256 ? root.id : null,
      model:
        typeof root.model === "string" && root.model.length <= 200 ? root.model : null,
      usage: usageFrom(root.usage),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function readBoundedImage(path: string, label: string): Promise<string> {
  await assertRegularFile(path, label);
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0));
  } finally {
    await handle.close();
  }
  if (bytesRead > MAX_IMAGE_BYTES)
    throw new Error(`${label} exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
  const bytes = buffer.subarray(0, bytesRead);
  if (
    bytes.byteLength < 8 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error(`${label} is not a PNG image`);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

export async function writeUsage(path: string, usage: OpenRouterUsage): Promise<void> {
  await writeBoundedJson(path, usage, MAX_METADATA_BYTES);
}

export function metadata(result: CompletionResult) {
  return ExecutionMetadataSchema.parse({
    schemaVersion: 1,
    observedHarnessVersion: "1.0.0",
    observedModelVersion: result.model,
    providerRequestId: result.requestId,
  });
}

export function extractJsonObject(content: string): string {
  const json = extractLastJsonValue(content);
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OpenRouter judge output must contain one JSON object");
  }
  if (Buffer.byteLength(json, "utf8") > MAX_JUDGE_OUTPUT_BYTES) {
    throw new Error("OpenRouter judge JSON exceeds the output limit");
  }
  return json;
}
