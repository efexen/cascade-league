#!/usr/bin/env node

import { join } from "node:path";

import {
  MAX_CSS_BYTES,
  MAX_METADATA_BYTES,
  MAX_PROMPT_BYTES,
  ExecutionMetadataSchema,
  assertRegularFile,
  buildContestantCodexArgv,
  invokeCodex,
  isEntrypoint,
  option,
  parseOptions,
  readBoundedText,
  readCodexVersion,
  writeBoundedJson,
  type ExecutionMetadata,
} from "./shared.js";

export interface ContestantOptions {
  readonly codexPath: string;
  readonly codexVersion: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly workspacePath: string;
  readonly challengePath: string;
  readonly starterCssPath: string;
  readonly promptPath: string;
  readonly submissionPath: string;
  readonly executionMetadataPath: string;
}

export function parseContestantOptions(argv: readonly string[]): ContestantOptions {
  const options = parseOptions(argv, [
    "--codex-path",
    "--codex-version",
    "--model",
    "--reasoning-effort",
    "--workspace-path",
    "--challenge-path",
    "--starter-css-path",
    "--prompt-path",
    "--submission-path",
    "--execution-metadata-path",
  ]);
  return {
    codexPath: option(options, "--codex-path"),
    codexVersion: option(options, "--codex-version"),
    model: option(options, "--model"),
    reasoningEffort: option(options, "--reasoning-effort"),
    workspacePath: option(options, "--workspace-path"),
    challengePath: option(options, "--challenge-path"),
    starterCssPath: option(options, "--starter-css-path"),
    promptPath: option(options, "--prompt-path"),
    submissionPath: option(options, "--submission-path"),
    executionMetadataPath: option(options, "--execution-metadata-path"),
  };
}

function contestantPrompt(prompt: string, submissionPath: string): string {
  return `${prompt.trimEnd()}

Wrapper instructions:
- Write exactly one regular file named submission.css at ${submissionPath}.
- Use CSS only and do not modify the supplied HTML or challenge assets.
- Do not use browser, computer-use, screenshot, preview, or visual inspection tools.
- Do not make another attempt or retry after this invocation.
`;
}

export async function runContestant(input: ContestantOptions): Promise<void> {
  await readBoundedText(input.challengePath, "challenge HTML", MAX_PROMPT_BYTES);
  await readBoundedText(input.starterCssPath, "starter CSS", MAX_CSS_BYTES);
  const prompt = await readBoundedText(
    input.promptPath,
    "contestant prompt",
    MAX_PROMPT_BYTES,
  );

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

  const outputLastMessagePath = join(input.workspacePath, ".codex-last-message.txt");
  await invokeCodex({
    executable: input.codexPath,
    argv: buildContestantCodexArgv({
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      workspacePath: input.workspacePath,
      outputLastMessagePath,
    }),
    cwd: input.workspacePath,
    prompt: contestantPrompt(prompt, input.submissionPath),
  });
  await assertRegularFile(input.submissionPath, "submission.css");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runContestant(parseContestantOptions(argv));
}

if (isEntrypoint(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(
      `codex contestant wrapper failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
