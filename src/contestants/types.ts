import type { Run } from "../schemas/index.js";
import type { ContestantConfig } from "../schemas/index.js";

export type ContestantRunUsage = Run["usage"];
export type ContestantRunStatus = Run["status"];

export interface ContestantRunInput {
  readonly generationId: string;
  readonly contestantId: string;
  readonly anonymousCandidateId: string;
  readonly contestant: ContestantConfig;
  readonly workspacePath: string;
  readonly challengePath: string;
  readonly starterCssPath: string;
  readonly promptPath: string;
  readonly submissionPath: string;
  readonly usageOutputPath: string;
  readonly stdoutLogPath: string;
  readonly stderrLogPath: string;
  readonly timeoutMs: number;
  readonly maximumTotalTokens: number;
  readonly redactionValues?: readonly string[];
}

export interface ContestantRunResult {
  readonly status: ContestantRunStatus;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly attemptCount: 1;
  readonly usage: ContestantRunUsage;
  readonly observedVersions: {
    readonly harness: string;
    readonly model: string;
  };
  readonly error: string | null;
  readonly submissionProduced: boolean;
  readonly usageProduced: boolean;
  readonly terminationSignals: readonly ("SIGTERM" | "SIGKILL")[];
}

export interface ContestantAdapter {
  run(input: ContestantRunInput): Promise<ContestantRunResult>;
}
