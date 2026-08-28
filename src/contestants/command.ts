import { isAbsolute } from "node:path";

import type { ContestantConfig } from "../schemas/index.js";
import type {
  ContestantAdapter,
  ContestantRunInput,
  ContestantRunResult,
} from "./types.js";
import {
  DEFAULT_TERMINATION_GRACE_MS,
  DEFAULT_LOG_LIMIT_BYTES,
  NOT_RECORDED_VERSION,
  readUsageFile,
  regularFileExists,
  runBoundedCommand,
  type CommandSpawnProcess,
} from "./support.js";

export interface ContestantCommandPaths {
  readonly workspacePath: string;
  readonly challengePath: string;
  readonly starterCssPath: string;
  readonly promptPath: string;
  readonly submissionPath: string;
  readonly usageOutputPath: string;
}

export type SpawnProcess = CommandSpawnProcess;

export interface CommandContestantAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnProcess?: SpawnProcess;
  readonly terminationGraceMs?: number;
  readonly maximumLogBytes?: number;
}

function placeholderValues(paths: ContestantCommandPaths): ReadonlyMap<string, string> {
  return new Map([
    ["{workspacePath}", paths.workspacePath],
    ["{challengePath}", paths.challengePath],
    ["{starterCssPath}", paths.starterCssPath],
    ["{promptPath}", paths.promptPath],
    ["{submissionPath}", paths.submissionPath],
    ["{usageOutputPath}", paths.usageOutputPath],
  ]);
}

export function materializeContestantArgv(
  argv: readonly string[],
  paths: ContestantCommandPaths,
): string[] {
  const values = placeholderValues(paths);
  return argv.map((argument, index) => {
    const replacement = values.get(argument);
    if (replacement !== undefined) {
      return replacement;
    }
    if (argument.includes("{") || argument.includes("}")) {
      throw new Error(`unsupported or embedded command placeholder at argv[${index}]`);
    }
    if (/[;&|`\r\n]|\$\(/u.test(argument)) {
      throw new Error(`shell fragment at argv[${index}]`);
    }
    return argument;
  });
}

function configuredCommand(contestant: ContestantConfig) {
  if (contestant.harness.adapter !== "command") {
    throw new Error("CommandContestantAdapter requires a command contestant harness");
  }
  return contestant.harness.command;
}

function explicitEnvironment(
  names: readonly string[],
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function appendError(current: string | null, next: string | null): string | null {
  if (current === null) return next;
  if (next === null) return current;
  return `${current}; ${next}`;
}

export class CommandContestantAdapter implements ContestantAdapter {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnProcess: SpawnProcess | undefined;
  private readonly terminationGraceMs: number;
  private readonly maximumLogBytes: number | undefined;

  public constructor(options: CommandContestantAdapterOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.spawnProcess = options.spawnProcess;
    this.terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.maximumLogBytes = options.maximumLogBytes;
  }

  public async run(input: ContestantRunInput): Promise<ContestantRunResult> {
    const command = configuredCommand(input.contestant);
    const argv = materializeContestantArgv(command.argv, input);
    const executable = argv[0];
    if (executable === undefined || !isAbsolute(executable)) {
      throw new Error("contestant executable must remain an absolute path");
    }
    const environment = explicitEnvironment(
      command.environmentAllowlist,
      this.environment,
    );
    const secretValues = [
      ...(input.redactionValues ?? []),
      ...command.environmentAllowlist.flatMap((name) => {
        const value = this.environment[name];
        return value === undefined ? [] : [value];
      }),
    ];
    const maximumLogBytes = this.maximumLogBytes ?? DEFAULT_LOG_LIMIT_BYTES;
    const processResult = await runBoundedCommand({
      argv,
      cwd: input.workspacePath,
      env: environment,
      timeoutMs: input.timeoutMs,
      terminationGraceMs: this.terminationGraceMs,
      maximumLogBytes,
      redactionValues: secretValues,
      stdoutLogPath: input.stdoutLogPath,
      stderrLogPath: input.stderrLogPath,
      ...(this.spawnProcess === undefined ? {} : { spawnProcess: this.spawnProcess }),
    });

    const usageResult = await readUsageFile(input.usageOutputPath, false);
    const submissionProduced = await regularFileExists(input.submissionPath);
    let error: string | null = appendError(processResult.error, usageResult.error);
    if (processResult.timedOut) {
      error = appendError(error, "contestant process timed out");
    } else if (processResult.exitCode !== 0) {
      error = appendError(
        error,
        processResult.signal === null
          ? `contestant process exited with code ${String(processResult.exitCode)}`
          : `contestant process terminated by ${processResult.signal}`,
      );
    } else if (!submissionProduced) {
      error = appendError(error, "contestant produced no submission.css");
    }
    let status: ContestantRunResult["status"];
    if (processResult.timedOut) {
      status = "timeout";
    } else if (processResult.error !== null || processResult.exitCode !== 0) {
      status = "failed";
    } else if (!submissionProduced) {
      status = "missing_submission";
    } else {
      status = "succeeded";
    }
    return {
      status,
      exitCode: processResult.exitCode,
      timedOut: processResult.timedOut,
      attemptCount: 1,
      usage: usageResult.usage,
      observedVersions: {
        harness: input.contestant.harness.version ?? NOT_RECORDED_VERSION,
        model: input.contestant.model.version,
      },
      error,
      submissionProduced,
      usageProduced: usageResult.exists,
      terminationSignals: processResult.terminationSignals,
    };
  }
}
