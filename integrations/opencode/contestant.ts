#!/usr/bin/env node

import {
  MAX_CSS_BYTES,
  MAX_METADATA_BYTES,
  MAX_PROMPT_BYTES,
  ExecutionMetadataSchema,
  assertRegularFile,
  invokeOpenCode,
  isEntrypoint,
  optionalOption,
  option,
  parseOptions,
  readBoundedText,
  readOpenCodeVersion,
  writeBoundedJson,
  type ExecutionMetadata,
} from "./shared.js";

export interface ContestantOptions {
  readonly opencodePath: string;
  readonly opencodeVersion: string;
  readonly model: string;
  readonly variant?: string;
  readonly reasoningEffort?: string;
  readonly workspacePath: string;
  readonly challengePath: string;
  readonly starterCssPath: string;
  readonly promptPath: string;
  readonly submissionPath: string;
  readonly executionMetadataPath: string;
}

export function parseContestantOptions(argv: readonly string[]): ContestantOptions {
  const values = parseOptions(argv, [
    "--opencode-path",
    "--opencode-version",
    "--model",
    "--workspace-path",
    "--challenge-path",
    "--starter-css-path",
    "--prompt-path",
    "--submission-path",
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
    challengePath: option(values, "--challenge-path"),
    starterCssPath: option(values, "--starter-css-path"),
    promptPath: option(values, "--prompt-path"),
    submissionPath: option(values, "--submission-path"),
    executionMetadataPath: option(values, "--execution-metadata-path"),
  };
}

export async function runContestant(input: ContestantOptions): Promise<void> {
  await readBoundedText(input.challengePath, "challenge HTML", MAX_PROMPT_BYTES);
  await readBoundedText(input.starterCssPath, "starter CSS", MAX_CSS_BYTES);
  const prompt = await readBoundedText(
    input.promptPath,
    "contestant prompt",
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
    `${prompt.trimEnd()}\n\nWrapper instructions:\n- Write exactly one regular file named submission.css at ${input.submissionPath}.\n- Do not retry, launch a browser, or inspect a rendered result.\n`,
    "--file",
    input.challengePath,
    "--file",
    input.starterCssPath,
  ];
  await invokeOpenCode({
    executable: input.opencodePath,
    argv,
    cwd: input.workspacePath,
    prompt: argv.at(-1)!,
  });
  await assertRegularFile(input.submissionPath, "submission.css");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runContestant(parseContestantOptions(argv));
}

if (isEntrypoint(import.meta.url))
  void main().catch((error: unknown) => {
    console.error(
      `opencode contestant wrapper failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
