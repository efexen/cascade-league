import { isAbsolute } from "node:path";
import { join } from "node:path";

import {
  CandidateJudgmentSchema,
  createGenerationAwardsSchema,
  JudgeCandidateResponseSchema,
  type CandidateJudgment,
} from "../schemas/index.js";
import {
  DEFAULT_TERMINATION_GRACE_MS,
  DEFAULT_JUDGE_OUTPUT_LIMIT_BYTES,
  DEFAULT_LOG_LIMIT_BYTES,
  boundedUtf8,
  emptyUsage,
  readExecutionMetadataFile,
  readUsageFile,
  readRegularFileAtMost,
  runBoundedCommand,
  writeTextAtomically,
  type CommandSpawnProcess,
} from "../contestants/support.js";
import type {
  JudgeAdapter,
  JudgeAwardsInput,
  JudgeAwardsResult,
  JudgeCandidateInput,
  JudgeCandidateResult,
  JudgeMeasuredUsage,
} from "./types.js";

export interface JudgeCommandPaths {
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly candidateScreenshotPath: string;
  readonly contactSheetPath: string;
  readonly sanitisedCssPath: string;
  readonly judgmentPath: string;
  readonly usageOutputPath: string;
  readonly executionMetadataOutputPath: string;
  readonly judgmentSummaryPath: string;
  readonly awardsPath: string;
}

export type JudgeSpawnProcess = CommandSpawnProcess;

export interface CommandJudgeAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnProcess?: JudgeSpawnProcess;
  readonly terminationGraceMs?: number;
  readonly maximumLogBytes?: number;
  readonly maximumOutputBytes?: number;
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly terminationSignals: readonly ("SIGTERM" | "SIGKILL")[];
  readonly stdout: readonly Buffer[];
  readonly stderr: readonly Buffer[];
  readonly error: string | null;
}

function pathsMap(paths: JudgeCommandPaths): ReadonlyMap<string, string> {
  return new Map([
    ["{workspacePath}", paths.workspacePath],
    ["{promptPath}", paths.promptPath],
    ["{candidateScreenshotPath}", paths.candidateScreenshotPath],
    ["{contactSheetPath}", paths.contactSheetPath],
    ["{sanitisedCssPath}", paths.sanitisedCssPath],
    ["{judgmentPath}", paths.judgmentPath],
    ["{usageOutputPath}", paths.usageOutputPath],
    ["{executionMetadataOutputPath}", paths.executionMetadataOutputPath],
    ["{judgmentSummaryPath}", paths.judgmentSummaryPath],
    ["{awardsPath}", paths.awardsPath],
  ]);
}

function assertMaterializablePaths(paths: JudgeCommandPaths): void {
  for (const [name, path] of Object.entries(paths)) {
    if (path.trim().length === 0) {
      throw new Error(`judge placeholder path ${name} must not be empty`);
    }
  }
}

export function materializeJudgeArgv(
  argv: readonly string[],
  paths: JudgeCommandPaths,
): string[] {
  assertMaterializablePaths(paths);
  const values = pathsMap(paths);
  return argv.map((argument, index) => {
    const replacement = values.get(argument);
    if (replacement !== undefined) return replacement;
    if (argument.includes("{") || argument.includes("}")) {
      throw new Error(`unsupported or embedded judge placeholder at argv[${index}]`);
    }
    if (/[;&|`\r\n]|\$\(/u.test(argument)) {
      throw new Error(`shell fragment at argv[${index}]`);
    }
    return argument;
  });
}

function measuredUsageFromFile(
  usage: ReturnType<typeof emptyUsage>,
): JudgeMeasuredUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
  };
}

function identityMatches(
  response: { generationId: string; judgeId: string; anonymousCandidateId: string },
  input: JudgeCandidateInput,
): boolean {
  return (
    response.generationId === input.generationId &&
    response.judgeId === input.judgeId &&
    response.anonymousCandidateId === input.anonymousCandidateId
  );
}

function appendError(current: string | null, next: string | null): string | null {
  if (current === null) return next;
  if (next === null) return current;
  return `${current}; ${next}`;
}

function judgeOutputLimit(
  maximumOutputTokens: number,
  override: number | undefined,
): number {
  if (override !== undefined) return Math.max(0, Math.floor(override));
  return Math.min(
    DEFAULT_JUDGE_OUTPUT_LIMIT_BYTES,
    Math.max(4096, Math.floor(maximumOutputTokens * 16)),
  );
}

function outputDiagnostic(
  path: string,
  result: Awaited<ReturnType<typeof readRegularFileAtMost>>,
  maximumBytes: number,
): string | null {
  if (result.kind === "too_large") {
    return `judge output at ${path} exceeds the ${maximumBytes}-byte limit`;
  }
  if (result.kind === "invalid") {
    return `judge output at ${path} is not a regular file`;
  }
  return null;
}

export class CommandJudgeAdapter implements JudgeAdapter {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnProcess: JudgeSpawnProcess | undefined;
  private readonly terminationGraceMs: number;
  private readonly maximumLogBytes: number | undefined;
  private readonly maximumOutputBytes: number | undefined;

  public constructor(options: CommandJudgeAdapterOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.spawnProcess = options.spawnProcess;
    this.terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.maximumLogBytes = options.maximumLogBytes;
    this.maximumOutputBytes = options.maximumOutputBytes;
  }

  private async execute(
    argv: readonly string[],
    workspacePath: string,
    environmentAllowlist: readonly string[],
    timeoutMs: number,
    stdoutLogPath: string,
    stderrLogPath: string,
  ): Promise<ProcessResult> {
    const executable = argv[0];
    if (executable === undefined || !isAbsolute(executable)) {
      throw new Error("judge executable must remain an absolute path");
    }
    const environment = Object.fromEntries(
      environmentAllowlist.flatMap((name) => {
        const value = this.environment[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
    const secretValues = environmentAllowlist.flatMap((name) => {
      const value = this.environment[name];
      return value === undefined ? [] : [value];
    });
    const maximumLogBytes = this.maximumLogBytes ?? DEFAULT_LOG_LIMIT_BYTES;
    return runBoundedCommand({
      argv,
      cwd: workspacePath,
      env: environment,
      timeoutMs,
      terminationGraceMs: this.terminationGraceMs,
      maximumLogBytes,
      redactionValues: secretValues,
      stdoutLogPath,
      stderrLogPath,
      ...(this.spawnProcess === undefined ? {} : { spawnProcess: this.spawnProcess }),
    });
  }

  private commandPaths(
    input: JudgeCandidateInput | JudgeAwardsInput,
  ): JudgeCommandPaths {
    if ("anonymousCandidateId" in input) {
      return {
        workspacePath: input.workspacePath,
        promptPath: input.promptPath,
        candidateScreenshotPath: input.candidateScreenshotPath,
        contactSheetPath: input.contactSheetPath,
        sanitisedCssPath: input.sanitisedCssPath,
        judgmentPath: input.judgmentPath,
        usageOutputPath: input.usageOutputPath,
        executionMetadataOutputPath: input.executionMetadataOutputPath,
        // These aliases intentionally point at the operation's one output.
        // The judge command is configured once and must work for both calls.
        judgmentSummaryPath: input.judgmentPath,
        awardsPath: input.judgmentPath,
      };
    }
    return {
      workspacePath: input.workspacePath,
      promptPath: input.promptPath,
      // Awards receive the cohort image, so it is the safe neutral alias for
      // the candidate-image placeholder during the second operation.
      candidateScreenshotPath: input.contactSheetPath,
      contactSheetPath: input.contactSheetPath,
      sanitisedCssPath: join(input.workspacePath, "candidate.css"),
      judgmentPath: input.awardsPath,
      usageOutputPath: input.usageOutputPath,
      executionMetadataOutputPath: input.executionMetadataOutputPath,
      judgmentSummaryPath: input.judgmentSummaryPath,
      // Both output aliases target the awards output for the awards call.
      awardsPath: input.awardsPath,
    };
  }

  private commandFor(judge: JudgeCandidateInput["judge"] | JudgeAwardsInput["judge"]) {
    if (judge.harness.adapter !== "command") {
      throw new Error("CommandJudgeAdapter requires a command judge harness");
    }
    return judge.harness.command;
  }

  public async scoreCandidate(
    input: JudgeCandidateInput,
  ): Promise<JudgeCandidateResult> {
    const command = this.commandFor(input.judge);
    const argv = materializeJudgeArgv(command.argv, this.commandPaths(input));
    const processResult = await this.execute(
      argv,
      input.workspacePath,
      command.environmentAllowlist,
      input.timeoutMs,
      input.stdoutLogPath,
      input.stderrLogPath,
    );
    const outputLimit = judgeOutputLimit(
      input.maximumOutputTokens,
      this.maximumOutputBytes,
    );
    const outputFile = await readRegularFileAtMost(input.judgmentPath, outputLimit);
    const outputExists = outputFile.kind === "ok";
    const oversizedOutput = outputDiagnostic(
      input.judgmentPath,
      outputFile,
      outputLimit,
    );
    const rawOutput =
      outputFile.kind === "ok"
        ? outputFile.bytes.toString("utf8")
        : (oversizedOutput ??
          boundedUtf8(
            processResult.stdout,
            outputLimit,
            command.environmentAllowlist.flatMap((name) => {
              const value = this.environment[name];
              return value === undefined ? [] : [value];
            }),
          ));
    if (rawOutput.length > 0) await writeTextAtomically(input.rawOutputPath, rawOutput);
    const usageResult = await readUsageFile(input.usageOutputPath, false);
    const usage = measuredUsageFromFile(usageResult.usage);
    // Bounded strict read of the optional private execution-metadata file,
    // equivalent to the contestant contract: missing metadata is allowed and
    // never changes the terminal result; invalid or oversized metadata stays
    // explicitly incomplete (null observations plus a bounded note) without
    // retry or crash.
    const metadataResult = await readExecutionMetadataFile(
      input.executionMetadataOutputPath,
    );
    const executionMetadata = metadataResult.metadata;
    const metadataProduced = metadataResult.exists;
    if (processResult.timedOut) {
      return {
        status: "timeout",
        response: null,
        judgment: null,
        usage,
        rawOutput: rawOutput.length === 0 ? null : rawOutput,
        error: appendError(
          appendError(processResult.error, "judge process timed out"),
          metadataResult.error,
        ),
        timedOut: true,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    }
    if (processResult.error !== null || processResult.exitCode !== 0) {
      return {
        status: "failed",
        response: null,
        judgment: null,
        usage,
        rawOutput: rawOutput.length === 0 ? null : rawOutput,
        error: appendError(
          appendError(
            processResult.error,
            processResult.exitCode === null
              ? "judge process did not exit normally"
              : `judge process exited with code ${String(processResult.exitCode)}`,
          ),
          metadataResult.error,
        ),
        timedOut: false,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    }
    if (oversizedOutput !== null) {
      return {
        status: "invalid",
        response: null,
        judgment: null,
        usage,
        rawOutput: rawOutput.length === 0 ? null : rawOutput,
        error: appendError(oversizedOutput, metadataResult.error),
        timedOut: false,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    }
    if (!outputExists) {
      return {
        status: "invalid",
        response: null,
        judgment: null,
        usage,
        rawOutput: rawOutput.length === 0 ? null : rawOutput,
        error: appendError("judge did not produce judgment.json", metadataResult.error),
        timedOut: false,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    }
    try {
      const response = JudgeCandidateResponseSchema.parse(
        JSON.parse(rawOutput) as unknown,
      );
      if (!identityMatches(response, input))
        throw new Error("judge response IDs do not match the task");
      const judgment: CandidateJudgment = CandidateJudgmentSchema.parse({
        ...response,
        modelUsage: usage,
      });
      return {
        status: "succeeded",
        response,
        judgment,
        usage,
        rawOutput,
        error: appendError(usageResult.error, metadataResult.error),
        timedOut: false,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    } catch (error) {
      return {
        status: "invalid",
        response: null,
        judgment: null,
        usage,
        rawOutput: rawOutput.length === 0 ? null : rawOutput,
        error: appendError(
          `judge response validation failed: ${error instanceof Error ? error.message : String(error)}`,
          metadataResult.error,
        ),
        timedOut: false,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    }
  }

  public async createAwards(input: JudgeAwardsInput): Promise<JudgeAwardsResult> {
    const command = this.commandFor(input.judge);
    const argv = materializeJudgeArgv(command.argv, this.commandPaths(input));
    const processResult = await this.execute(
      argv,
      input.workspacePath,
      command.environmentAllowlist,
      input.timeoutMs,
      input.stdoutLogPath,
      input.stderrLogPath,
    );
    const outputLimit = judgeOutputLimit(
      input.maximumOutputTokens,
      this.maximumOutputBytes,
    );
    const outputFile = await readRegularFileAtMost(input.awardsPath, outputLimit);
    const outputExists = outputFile.kind === "ok";
    const oversizedOutput = outputDiagnostic(input.awardsPath, outputFile, outputLimit);
    const rawOutput =
      outputFile.kind === "ok"
        ? outputFile.bytes.toString("utf8")
        : (oversizedOutput ??
          boundedUtf8(
            processResult.stdout,
            outputLimit,
            command.environmentAllowlist.flatMap((name) => {
              const value = this.environment[name];
              return value === undefined ? [] : [value];
            }),
          ));
    if (rawOutput.length > 0) await writeTextAtomically(input.rawOutputPath, rawOutput);
    const usageResult = await readUsageFile(input.usageOutputPath, false);
    const usage = measuredUsageFromFile(usageResult.usage);
    // Same bounded, non-fatal execution-metadata contract as candidate
    // scoring and the contestant adapter.
    const metadataResult = await readExecutionMetadataFile(
      input.executionMetadataOutputPath,
    );
    const executionMetadata = metadataResult.metadata;
    const metadataProduced = metadataResult.exists;
    if (processResult.timedOut) {
      return {
        status: "timeout",
        awards: null,
        rawOutput: rawOutput.length === 0 ? null : rawOutput,
        usage,
        error: appendError("awards process timed out", metadataResult.error),
        timedOut: true,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    }
    if (processResult.error !== null || processResult.exitCode !== 0) {
      return {
        status: "failed",
        awards: null,
        rawOutput: rawOutput.length === 0 ? null : rawOutput,
        usage,
        error: appendError(
          appendError(
            appendError(processResult.error, usageResult.error),
            processResult.exitCode === null
              ? "awards process did not exit normally"
              : `awards process exited with code ${String(processResult.exitCode)}`,
          ),
          metadataResult.error,
        ),
        timedOut: false,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    }
    if (oversizedOutput !== null) {
      return {
        status: "invalid",
        awards: null,
        rawOutput: rawOutput.length === 0 ? null : rawOutput,
        usage,
        error: appendError(oversizedOutput, metadataResult.error),
        timedOut: false,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    }
    if (!outputExists) {
      return {
        status: "invalid",
        awards: null,
        rawOutput: rawOutput.length === 0 ? null : rawOutput,
        usage,
        error: appendError("judge did not produce awards.json", metadataResult.error),
        timedOut: false,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    }
    try {
      const parsed = createGenerationAwardsSchema(
        input.candidates.map((candidate) => candidate.anonymousCandidateId),
      ).parse(JSON.parse(rawOutput) as unknown);
      if (
        parsed.generationId !== input.generationId ||
        parsed.judgeId !== input.judgeId
      ) {
        throw new Error("awards response IDs do not match the task");
      }
      return {
        status: "succeeded",
        awards: parsed,
        rawOutput,
        usage,
        error: metadataResult.error,
        timedOut: false,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    } catch (error) {
      return {
        status: "invalid",
        awards: null,
        rawOutput: rawOutput.length === 0 ? null : rawOutput,
        usage,
        error: appendError(
          `awards response validation failed: ${error instanceof Error ? error.message : String(error)}`,
          metadataResult.error,
        ),
        timedOut: false,
        attemptCount: 1,
        executionMetadata,
        metadataProduced,
      };
    }
  }
}
