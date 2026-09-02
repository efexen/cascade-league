#!/usr/bin/env node

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_CSS_BYTES,
  MAX_JUDGE_OUTPUT_BYTES,
  MAX_METADATA_BYTES,
  MAX_PROMPT_BYTES,
  ExecutionMetadataSchema,
  assertRegularFile,
  buildJudgeCodexArgv,
  invokeCodex,
  isEntrypoint,
  option,
  parseOptions,
  readBoundedText,
  readCodexVersion,
  writeBoundedJson,
  writeTextAtomically,
  type ExecutionMetadata,
} from "./shared.js";

export type JudgeOperation = "score" | "awards";

export interface JudgeOptions {
  readonly codexPath: string;
  readonly codexVersion: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly candidateScreenshotPath: string;
  readonly contactSheetPath: string;
  readonly sanitisedCssPath: string;
  readonly judgmentPath: string;
  readonly judgmentSummaryPath: string;
  readonly awardsPath: string;
  readonly executionMetadataPath: string;
}

export function parseJudgeOptions(argv: readonly string[]): JudgeOptions {
  const options = parseOptions(argv, [
    "--codex-path",
    "--codex-version",
    "--model",
    "--reasoning-effort",
    "--workspace-path",
    "--prompt-path",
    "--candidate-screenshot-path",
    "--contact-sheet-path",
    "--sanitised-css-path",
    "--judgment-path",
    "--judgment-summary-path",
    "--awards-path",
    "--execution-metadata-path",
  ]);
  return {
    codexPath: option(options, "--codex-path"),
    codexVersion: option(options, "--codex-version"),
    model: option(options, "--model"),
    reasoningEffort: option(options, "--reasoning-effort"),
    workspacePath: option(options, "--workspace-path"),
    promptPath: option(options, "--prompt-path"),
    candidateScreenshotPath: option(options, "--candidate-screenshot-path"),
    contactSheetPath: option(options, "--contact-sheet-path"),
    sanitisedCssPath: option(options, "--sanitised-css-path"),
    judgmentPath: option(options, "--judgment-path"),
    judgmentSummaryPath: option(options, "--judgment-summary-path"),
    awardsPath: option(options, "--awards-path"),
    executionMetadataPath: option(options, "--execution-metadata-path"),
  };
}

export function inferJudgeOperation(
  input: Pick<JudgeOptions, "judgmentPath" | "judgmentSummaryPath" | "awardsPath">,
): JudgeOperation {
  if (
    input.judgmentPath === input.judgmentSummaryPath &&
    input.judgmentPath === input.awardsPath
  ) {
    return "score";
  }
  if (
    input.judgmentPath === input.awardsPath &&
    input.judgmentSummaryPath !== input.judgmentPath
  ) {
    return "awards";
  }
  throw new Error(
    "judge operation could not be inferred from the generic judgment and awards path aliases",
  );
}

function judgePrompt(
  prompt: string,
  operation: JudgeOperation,
  textInput: string,
): string {
  const inputDescription =
    operation === "score"
      ? "Read candidate.png and cohort.png, then use the staged candidate CSS below."
      : "Read cohort.png and the staged judgment summary below.";
  const textLabel = operation === "score" ? "Candidate CSS" : "Judgment summary";
  return `${prompt.trimEnd()}

Wrapper input instructions:
- ${inputDescription}
- Return only the JSON object requested by the prompt, with no Markdown fences or extra prose.

${textLabel}:
${textInput}
`;
}

export async function runJudge(input: JudgeOptions): Promise<void> {
  const operation = inferJudgeOperation(input);
  const prompt = await readBoundedText(
    input.promptPath,
    "judge prompt",
    MAX_PROMPT_BYTES,
  );
  await assertRegularFile(input.contactSheetPath, "cohort contact sheet");
  const imagePaths = [input.contactSheetPath];
  let textInput: string;
  if (operation === "score") {
    await assertRegularFile(input.candidateScreenshotPath, "candidate screenshot");
    textInput = await readBoundedText(
      input.sanitisedCssPath,
      "sanitised candidate CSS",
      MAX_CSS_BYTES,
    );
    imagePaths.unshift(input.candidateScreenshotPath);
  } else {
    textInput = await readBoundedText(
      input.judgmentSummaryPath,
      "judgment summary",
      MAX_PROMPT_BYTES,
    );
    try {
      const parsed = JSON.parse(textInput) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("judgment summary must be a JSON object");
      }
    } catch (error) {
      throw new Error(
        `judgment summary is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const observedCodexVersion = await readCodexVersion(input.codexPath);
  if (observedCodexVersion !== input.codexVersion) {
    throw new Error(
      `configured Codex version ${input.codexVersion} does not match executable version ${observedCodexVersion}`,
    );
  }
  const metadata: ExecutionMetadata = {
    observedHarnessVersion: observedCodexVersion,
    observedModelVersion: input.model,
    providerRequestId: null,
  };
  await writeBoundedJson(
    input.executionMetadataPath,
    ExecutionMetadataSchema.parse({ schemaVersion: 1, ...metadata }),
    MAX_METADATA_BYTES,
  );

  const outputPath = operation === "score" ? input.judgmentPath : input.awardsPath;
  const outputLastMessagePath = join(
    input.workspacePath,
    `.codex-last-message-${operation}.json`,
  );
  const outputSchemaPath = fileURLToPath(
    new URL(`./${operation}-output-schema.json`, import.meta.url),
  );
  await invokeCodex({
    executable: input.codexPath,
    argv: buildJudgeCodexArgv({
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      sandbox: "read-only",
      workspacePath: input.workspacePath,
      imagePaths,
      outputSchemaPath,
      outputLastMessagePath,
    }),
    cwd: input.workspacePath,
    prompt: judgePrompt(prompt, operation, textInput),
  });

  const finalMessage = await readBoundedText(
    outputLastMessagePath,
    "Codex final response",
    MAX_JUDGE_OUTPUT_BYTES,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalMessage) as unknown;
  } catch (error) {
    throw new Error(
      `Codex final response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex final response must be a JSON object");
  }
  await writeTextAtomically(
    outputPath,
    finalMessage.endsWith("\n") ? finalMessage : `${finalMessage}\n`,
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runJudge(parseJudgeOptions(argv));
}

if (isEntrypoint(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(
      `codex judge wrapper failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
