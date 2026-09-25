#!/usr/bin/env node

import {
  MAX_CSS_BYTES,
  MAX_PROMPT_BYTES,
  assertRegularFile,
  extractJsonObject,
  isEntrypoint,
  option,
  parseOptions,
  parseRequestTimeout,
  readBoundedImage,
  readBoundedText,
  requestCompletion,
  metadata,
  writeBoundedJson,
  writeTextAtomically,
  writeUsage,
} from "./shared.js";

export type JudgeOperation = "score" | "awards";
export interface JudgeOptions {
  readonly model: string;
  readonly maxCompletionTokens: number;
  readonly requestTimeoutMs?: number;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly candidateScreenshotPath: string;
  readonly contactSheetPath: string;
  readonly sanitisedCssPath: string;
  readonly judgmentPath: string;
  readonly judgmentSummaryPath: string;
  readonly awardsPath: string;
  readonly executionMetadataPath: string;
  readonly usagePath: string;
}

export function parseJudgeOptions(argv: readonly string[]): JudgeOptions {
  const values = parseOptions(argv, [
    "--model",
    "--max-completion-tokens",
    "--workspace-path",
    "--prompt-path",
    "--candidate-screenshot-path",
    "--contact-sheet-path",
    "--sanitised-css-path",
    "--judgment-path",
    "--judgment-summary-path",
    "--awards-path",
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
    promptPath: option(values, "--prompt-path"),
    candidateScreenshotPath: option(values, "--candidate-screenshot-path"),
    contactSheetPath: option(values, "--contact-sheet-path"),
    sanitisedCssPath: option(values, "--sanitised-css-path"),
    judgmentPath: option(values, "--judgment-path"),
    judgmentSummaryPath: option(values, "--judgment-summary-path"),
    awardsPath: option(values, "--awards-path"),
    executionMetadataPath: option(values, "--execution-metadata-path"),
    usagePath: option(values, "--usage-path"),
  };
}

export function inferJudgeOperation(
  input: Pick<JudgeOptions, "judgmentPath" | "judgmentSummaryPath" | "awardsPath">,
): JudgeOperation {
  if (
    input.judgmentPath === input.judgmentSummaryPath &&
    input.judgmentPath === input.awardsPath
  )
    return "score";
  if (
    input.judgmentPath === input.awardsPath &&
    input.judgmentSummaryPath !== input.judgmentPath
  )
    return "awards";
  throw new Error("judge operation could not be inferred from generic path aliases");
}

export async function runJudge(
  input: JudgeOptions,
  deps: { endpoint?: string; fetchImpl?: typeof fetch; apiKey?: string } = {},
): Promise<void> {
  const operation = inferJudgeOperation(input);
  const prompt = await readBoundedText(
    input.promptPath,
    "judge prompt",
    MAX_PROMPT_BYTES,
  );
  const text =
    operation === "score"
      ? await readBoundedText(
          input.sanitisedCssPath,
          "sanitised candidate CSS",
          MAX_CSS_BYTES,
        )
      : await readBoundedText(
          input.judgmentSummaryPath,
          "judgment summary",
          MAX_PROMPT_BYTES,
        );
  const contactSheet = await readBoundedImage(input.contactSheetPath, "contact sheet");
  const images =
    operation === "score"
      ? [
          await readBoundedImage(input.candidateScreenshotPath, "candidate screenshot"),
          contactSheet,
        ]
      : [contactSheet];
  const promptText = `${prompt.trimEnd()}\n\n${operation === "score" ? "Sanitised candidate CSS" : "Judgment summary"}:\n${text}\n\nReturn only the requested JSON object, without Markdown fences or commentary.`;
  const content = [
    { type: "text", text: promptText },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
  const response = await requestCompletion(
    {
      apiKey: deps.apiKey ?? process.env.OPENROUTER_API_KEY ?? "",
      model: input.model,
      maxCompletionTokens: input.maxCompletionTokens,
      ...(input.requestTimeoutMs === undefined
        ? {}
        : { timeoutMs: input.requestTimeoutMs }),
      content,
    },
    {
      ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    },
  );
  await assertRegularFile(input.contactSheetPath, "contact sheet");
  const outputPath = operation === "score" ? input.judgmentPath : input.awardsPath;
  await writeTextAtomically(outputPath, `${extractJsonObject(response.content)}\n`);
  await writeBoundedJson(input.executionMetadataPath, metadata(response));
  await writeUsage(input.usagePath, response.usage);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runJudge(parseJudgeOptions(argv));
}
if (isEntrypoint(import.meta.url))
  void main().catch((error: unknown) => {
    console.error(
      `openrouter judge wrapper failed: ${error instanceof Error ? error.message : "request failed"}`,
    );
    process.exitCode = 1;
  });
