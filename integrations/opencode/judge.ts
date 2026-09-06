#!/usr/bin/env node

import {
  MAX_CSS_BYTES,
  MAX_JUDGE_OUTPUT_BYTES,
  MAX_METADATA_BYTES,
  MAX_PROMPT_BYTES,
  ExecutionMetadataSchema,
  assertRegularFile,
  extractLastJsonValue,
  invokeOpenCode,
  isEntrypoint,
  optionalOption,
  option,
  parseOptions,
  readBoundedText,
  readOpenCodeVersion,
  writeBoundedJson,
  writeTextAtomically,
  type ExecutionMetadata,
} from "./shared.js";

export type JudgeOperation = "score" | "awards";
export interface JudgeOptions {
  readonly opencodePath: string;
  readonly opencodeVersion: string;
  readonly model: string;
  readonly variant?: string;
  readonly reasoningEffort?: string;
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
  const values = parseOptions(argv, [
    "--opencode-path",
    "--opencode-version",
    "--model",
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
  const variant = optionalOption(values, "--variant");
  const reasoningEffort = optionalOption(values, "--reasoning-effort");
  return {
    opencodePath: option(values, "--opencode-path"),
    opencodeVersion: option(values, "--opencode-version"),
    model: option(values, "--model"),
    ...(variant === undefined ? {} : { variant }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    workspacePath: option(values, "--workspace-path"),
    promptPath: option(values, "--prompt-path"),
    candidateScreenshotPath: option(values, "--candidate-screenshot-path"),
    contactSheetPath: option(values, "--contact-sheet-path"),
    sanitisedCssPath: option(values, "--sanitised-css-path"),
    judgmentPath: option(values, "--judgment-path"),
    judgmentSummaryPath: option(values, "--judgment-summary-path"),
    awardsPath: option(values, "--awards-path"),
    executionMetadataPath: option(values, "--execution-metadata-path"),
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

export async function runJudge(input: JudgeOptions): Promise<void> {
  const operation = inferJudgeOperation(input);
  const prompt = await readBoundedText(
    input.promptPath,
    "judge prompt",
    MAX_PROMPT_BYTES,
  );
  await assertRegularFile(input.contactSheetPath, "cohort contact sheet");
  const imagePaths =
    operation === "score"
      ? [input.candidateScreenshotPath, input.contactSheetPath]
      : [input.contactSheetPath];
  for (const path of imagePaths) await assertRegularFile(path, "judge image");
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
  const observedVersion = await readOpenCodeVersion(input.opencodePath);
  if (observedVersion !== input.opencodeVersion)
    throw new Error(
      `configured OpenCode version ${input.opencodeVersion} does not match executable version ${observedVersion}`,
    );
  const metadata: ExecutionMetadata = {
    observedHarnessVersion: observedVersion,
    observedModelVersion: input.model,
    providerRequestId: null,
  };
  await writeBoundedJson(
    input.executionMetadataPath,
    ExecutionMetadataSchema.parse({ schemaVersion: 1, ...metadata }),
    MAX_METADATA_BYTES,
  );
  const outputPath = operation === "score" ? input.judgmentPath : input.awardsPath;
  const promptWithInput = `${prompt.trimEnd()}\n\n${operation === "score" ? "Candidate CSS" : "Judgment summary"}:\n${text}\n\nWrapper instruction: return only the requested JSON object.`;
  const argv = [
    "run",
    "--format",
    "json",
    "--model",
    input.model,
    ...(input.variant === undefined ? [] : ["--variant", input.variant]),
    ...(input.variant === undefined && input.reasoningEffort === undefined
      ? []
      : input.variant === undefined
        ? ["--variant", input.reasoningEffort!]
        : []),
    "--dir",
    input.workspacePath,
    promptWithInput,
    ...imagePaths.flatMap((path) => ["--file", path]),
  ];
  const raw = await invokeOpenCode({
    executable: input.opencodePath,
    argv,
    cwd: input.workspacePath,
    prompt: promptWithInput,
  });
  const finalJson = extractLastJsonValue(raw);
  if (Buffer.byteLength(finalJson, "utf8") > MAX_JUDGE_OUTPUT_BYTES)
    throw new Error("OpenCode final JSON exceeds the output limit");
  await writeTextAtomically(outputPath, `${finalJson}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runJudge(parseJudgeOptions(argv));
}

if (isEntrypoint(import.meta.url))
  void main().catch((error: unknown) => {
    console.error(
      `opencode judge wrapper failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
