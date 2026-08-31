import type {
  CandidateJudgment,
  GenerationAwards,
  JudgeCandidateResponse,
  JudgeConfig,
} from "../schemas/index.js";
import type { ContestantRunUsage } from "../contestants/types.js";
import type { ExecutionMetadata } from "../contestants/support.js";

export interface JudgeMeasuredUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly estimatedCostUsd: number | null;
}

export interface JudgeCandidateInput {
  readonly generationId: string;
  readonly judgeId: string;
  readonly anonymousCandidateId: string;
  readonly judge: JudgeConfig;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly candidateScreenshotPath: string;
  readonly contactSheetPath: string;
  readonly sanitisedCssPath: string;
  readonly judgmentPath: string;
  readonly rawOutputPath: string;
  readonly usageOutputPath: string;
  readonly executionMetadataOutputPath: string;
  readonly stdoutLogPath: string;
  readonly stderrLogPath: string;
  readonly timeoutMs: number;
  readonly maximumOutputTokens: number;
}

export interface JudgeCandidateResult {
  readonly status: "succeeded" | "invalid" | "failed" | "timeout";
  readonly response: JudgeCandidateResponse | null;
  readonly judgment: CandidateJudgment | null;
  readonly usage: JudgeMeasuredUsage;
  readonly rawOutput: string | null;
  readonly error: string | null;
  readonly timedOut: boolean;
  readonly attemptCount: 1;
  readonly executionMetadata: ExecutionMetadata;
  readonly metadataProduced: boolean;
}

export interface JudgeAwardsCandidate {
  readonly anonymousCandidateId: string;
  readonly judgment: CandidateJudgment | null;
  readonly sanitisedCssPath: string;
}

export interface JudgeAwardsInput {
  readonly generationId: string;
  readonly judgeId: string;
  readonly judge: JudgeConfig;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly contactSheetPath: string;
  readonly judgmentSummaryPath: string;
  readonly awardsPath: string;
  readonly usageOutputPath: string;
  readonly executionMetadataOutputPath: string;
  readonly rawOutputPath: string;
  readonly stdoutLogPath: string;
  readonly stderrLogPath: string;
  readonly timeoutMs: number;
  readonly maximumOutputTokens: number;
  readonly candidates: readonly JudgeAwardsCandidate[];
}

export interface JudgeAwardsResult {
  readonly status: "succeeded" | "invalid" | "failed" | "timeout";
  readonly awards: GenerationAwards | null;
  readonly rawOutput: string | null;
  readonly usage: JudgeMeasuredUsage;
  readonly error: string | null;
  readonly timedOut: boolean;
  readonly attemptCount: 1;
  readonly executionMetadata: ExecutionMetadata;
  readonly metadataProduced: boolean;
}

export interface JudgeAdapter {
  scoreCandidate(input: JudgeCandidateInput): Promise<JudgeCandidateResult>;
  createAwards(input: JudgeAwardsInput): Promise<JudgeAwardsResult>;
}

export function measuredUsageFromContestantUsage(
  usage: ContestantRunUsage,
): JudgeMeasuredUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
  };
}
