#!/usr/bin/env node

import {
  MAX_CSS_BYTES,
  MAX_PROMPT_BYTES,
  assertRegularFile,
  isEntrypoint,
  option,
  parseOptions,
  parseRequestTimeout,
  readBoundedText,
  requestCompletion,
  metadata,
  writeBoundedJson,
  writeTextAtomically,
  writeUsage,
} from "./shared.js";

export interface ContestantOptions {
  readonly model: string;
  readonly maxCompletionTokens: number;
  readonly requestTimeoutMs?: number;
  readonly workspacePath: string;
  readonly challengePath: string;
  readonly starterCssPath: string;
  readonly promptPath: string;
  readonly submissionPath: string;
  readonly executionMetadataPath: string;
  readonly usagePath: string;
}

function normalizeContestantCss(content: string): string {
  const fenced = content.match(/^```css\r?\n([\s\S]*\r?\n)```(?:\r?\n)?$/iu);
  const css = fenced?.[1] ?? content;
  if (
    (!fenced && /```/u.test(content)) ||
    (fenced && /```/u.test(css)) ||
    Buffer.byteLength(css, "utf8") > MAX_CSS_BYTES
  ) {
    throw new Error("OpenRouter response is not bounded plain CSS");
  }
  return fenced ? css : `${css}\n`;
}

export function parseContestantOptions(argv: readonly string[]): ContestantOptions {
  const values = parseOptions(argv, [
    "--model",
    "--max-completion-tokens",
    "--workspace-path",
    "--challenge-path",
    "--starter-css-path",
    "--prompt-path",
    "--submission-path",
    "--execution-metadata-path",
    "--usage-path",
  ]);
  const maxCompletionTokens = Number(option(values, "--max-completion-tokens"));
  if (
    !Number.isSafeInteger(maxCompletionTokens) ||
    maxCompletionTokens < 1 ||
    maxCompletionTokens > 32768
  )
    throw new Error("--max-completion-tokens must be an integer from 1 to 32768");
  return {
    model: option(values, "--model"),
    maxCompletionTokens,
    requestTimeoutMs: parseRequestTimeout(values["--request-timeout-ms"]),
    workspacePath: option(values, "--workspace-path"),
    challengePath: option(values, "--challenge-path"),
    starterCssPath: option(values, "--starter-css-path"),
    promptPath: option(values, "--prompt-path"),
    submissionPath: option(values, "--submission-path"),
    executionMetadataPath: option(values, "--execution-metadata-path"),
    usagePath: option(values, "--usage-path"),
  };
}

export async function runContestant(
  input: ContestantOptions,
  deps: { endpoint?: string; fetchImpl?: typeof fetch; apiKey?: string } = {},
): Promise<void> {
  const prompt = await readBoundedText(
    input.promptPath,
    "contestant prompt",
    MAX_PROMPT_BYTES,
  );
  const challenge = await readBoundedText(
    input.challengePath,
    "challenge HTML",
    MAX_PROMPT_BYTES,
  );
  const starterCss = await readBoundedText(
    input.starterCssPath,
    "starter CSS",
    MAX_CSS_BYTES,
  );
  const response = await requestCompletion(
    {
      apiKey: deps.apiKey ?? process.env.OPENROUTER_API_KEY ?? "",
      model: input.model,
      maxCompletionTokens: input.maxCompletionTokens,
      ...(input.requestTimeoutMs === undefined
        ? {}
        : { timeoutMs: input.requestTimeoutMs }),
      content: `${prompt.trimEnd()}\n\nDirect-response adapter: you have no filesystem or browser access. The adapter will write your response to the named submission.css path. Treat the following inlined files as the supplied local files; do not claim to have opened or written them.\n\nChallenge HTML:\n${challenge}\n\nStarter CSS:\n${starterCss}\n\nRespond with only the complete CSS for submission.css, without Markdown fences or explanation. This is your sole attempt; do not request a retry or a preview.`,
    },
    {
      ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    },
  );
  const css = normalizeContestantCss(response.content);
  await writeTextAtomically(input.submissionPath, css);
  await assertRegularFile(input.submissionPath, "submission.css");
  await writeBoundedJson(input.executionMetadataPath, metadata(response));
  await writeUsage(input.usagePath, response.usage);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runContestant(parseContestantOptions(argv));
}
if (isEntrypoint(import.meta.url))
  void main().catch((error: unknown) => {
    console.error(
      `openrouter contestant wrapper failed: ${error instanceof Error ? error.message : "request failed"}`,
    );
    process.exitCode = 1;
  });
