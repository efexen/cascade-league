import { z } from "zod";

import {
  AnonymousCandidateIdSchema,
  ContestantIdSchema,
  GenerationIdSchema,
  JudgeIdSchema,
  NonNegativeIntegerSchema,
  NonNegativeNumberSchema,
  OptionalTimestampSchema,
  PositiveIntegerSchema,
  SchemaVersionSchema,
  SeasonIdSchema,
  SlugSchema,
  UtcTimestampSchema,
  uniqueValues,
} from "./common.js";
import { TaskRoleSchema } from "./artifacts.js";

const StrictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// Phase 2 §6.8: the private, deterministic `run-summary.json` artifact. Every
// field is derived from durable generation artifacts only. Unknown values stay
// `null`; a known `0` is always distinct from an unknown. Known aggregates are
// labelled `"partial"` whenever at least one relevant call has unknown data.
// Provider request IDs, prompts, logs, environment names, filesystem paths,
// and raw model output never enter this schema.

/** Completeness of the two observed-version fields of a single model call. */
export const CallVersionCompletenessSchema = z.enum(["complete", "partial", "unknown"]);

/** A known aggregate; `"partial"` means at least one relevant call was unknown. */
export const AggregateCompletenessSchema = z.enum(["complete", "partial"]);

const IntegerAggregateSchema = StrictObject({
  value: NonNegativeIntegerSchema,
  completeness: AggregateCompletenessSchema,
});

const CostAggregateSchema = StrictObject({
  value: NonNegativeNumberSchema,
  completeness: AggregateCompletenessSchema,
});

const ContestantUsageSchema = StrictObject({
  inputTokens: NonNegativeIntegerSchema.nullable(),
  outputTokens: NonNegativeIntegerSchema.nullable(),
  reasoningTokens: NonNegativeIntegerSchema.nullable(),
  totalTokens: NonNegativeIntegerSchema.nullable(),
});

const JudgeUsageSchema = StrictObject({
  inputTokens: NonNegativeIntegerSchema.nullable(),
  outputTokens: NonNegativeIntegerSchema.nullable(),
  totalTokens: NonNegativeIntegerSchema.nullable(),
});

const TaskRoleCountsSchema = StrictObject({
  role: TaskRoleSchema,
  planned: NonNegativeIntegerSchema,
  // `null` counts mean no durable task-state evidence exists for this role at
  // all (for example an archived Phase 1 generation); they are never zero.
  started: NonNegativeIntegerSchema.nullable(),
  succeeded: NonNegativeIntegerSchema.nullable(),
  failed: NonNegativeIntegerSchema.nullable(),
  timeout: NonNegativeIntegerSchema.nullable(),
  missingSubmission: NonNegativeIntegerSchema.nullable(),
  invalid: NonNegativeIntegerSchema.nullable(),
  uncertain: NonNegativeIntegerSchema.nullable(),
});

const ContestantSummarySchema = StrictObject({
  contestantId: ContestantIdSchema,
  anonymousCandidateId: AnonymousCandidateIdSchema,
  durationMs: NonNegativeIntegerSchema.nullable(),
  usage: ContestantUsageSchema,
  estimatedCostUsd: NonNegativeNumberSchema.nullable(),
  versionCompleteness: CallVersionCompletenessSchema,
  oneShotEnforcement: z.enum(["enforced", "prompt_only"]).nullable(),
});

const JudgeCandidateCallSchema = StrictObject({
  anonymousCandidateId: AnonymousCandidateIdSchema,
  durationMs: NonNegativeIntegerSchema.nullable(),
  usage: JudgeUsageSchema,
  estimatedCostUsd: NonNegativeNumberSchema.nullable(),
  versionCompleteness: CallVersionCompletenessSchema,
});

const JudgeAwardsCallSchema = StrictObject({
  durationMs: NonNegativeIntegerSchema.nullable(),
  usage: JudgeUsageSchema,
  estimatedCostUsd: NonNegativeNumberSchema.nullable(),
  versionCompleteness: CallVersionCompletenessSchema,
});

const JudgeRunSummarySchema = StrictObject({
  judgeId: JudgeIdSchema,
  candidateCalls: z.array(JudgeCandidateCallSchema).superRefine((calls, context) => {
    if (!uniqueValues(calls.map((call) => call.anonymousCandidateId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "candidate calls must have unique anonymous candidate IDs",
      });
    }
  }),
  awardsCall: JudgeAwardsCallSchema,
});

const ResourceGroupObservationSchema = StrictObject({
  name: SlugSchema,
  configuredMaximumConcurrency: PositiveIntegerSchema,
  configuredMinimumStartIntervalMs: NonNegativeIntegerSchema,
  observedStartCount: NonNegativeIntegerSchema,
  // `null` observations mean the durable timestamps are insufficient to
  // observe the value (no completed call interval, or fewer than two starts).
  observedMaximumConcurrency: NonNegativeIntegerSchema.nullable(),
  observedMinimumStartIntervalMs: NonNegativeIntegerSchema.nullable(),
});

export const RunSummarySchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  seasonId: SeasonIdSchema,
  generationId: GenerationIdSchema,
  generatedAt: UtcTimestampSchema,
  wallClock: StrictObject({
    startedAt: OptionalTimestampSchema,
    completedAt: OptionalTimestampSchema,
    elapsedMs: NonNegativeIntegerSchema.nullable(),
  }),
  taskCounts: z
    .array(TaskRoleCountsSchema)
    .length(4)
    .superRefine((counts, context) => {
      if (!uniqueValues(counts.map((entry) => entry.role))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "task counts must name each role exactly once",
        });
      }
    }),
  contestants: z.array(ContestantSummarySchema).superRefine((entries, context) => {
    if (!uniqueValues(entries.map((entry) => entry.contestantId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "contestant summaries must have unique contestant IDs",
      });
    }
    if (!uniqueValues(entries.map((entry) => entry.anonymousCandidateId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "contestant summaries must have unique anonymous candidate IDs",
      });
    }
  }),
  judges: z.array(JudgeRunSummarySchema).superRefine((entries, context) => {
    if (!uniqueValues(entries.map((entry) => entry.judgeId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "judge summaries must have unique judge IDs",
      });
    }
  }),
  totals: StrictObject({
    inputTokens: IntegerAggregateSchema,
    outputTokens: IntegerAggregateSchema,
    reasoningTokens: IntegerAggregateSchema,
    totalTokens: IntegerAggregateSchema,
    estimatedCostUsd: CostAggregateSchema,
    callsWithUnknownUsage: NonNegativeIntegerSchema,
    callsWithUnknownCost: NonNegativeIntegerSchema,
  }),
  // Plan-derived; `null` for archived generations that predate `run-plan.json`.
  configuredMaximumCalls: NonNegativeIntegerSchema.nullable(),
  resourceGroups: z
    .array(ResourceGroupObservationSchema)
    .superRefine((groups, context) => {
      if (!uniqueValues(groups.map((group) => group.name))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "resource group observations must have unique names",
        });
      }
    }),
});

export type CallVersionCompleteness = z.infer<typeof CallVersionCompletenessSchema>;
export type AggregateCompleteness = z.infer<typeof AggregateCompletenessSchema>;
export type TaskRoleCounts = z.infer<typeof TaskRoleCountsSchema>;
export type ContestantSummary = z.infer<typeof ContestantSummarySchema>;
export type JudgeCandidateCall = z.infer<typeof JudgeCandidateCallSchema>;
export type JudgeAwardsCall = z.infer<typeof JudgeAwardsCallSchema>;
export type JudgeRunSummary = z.infer<typeof JudgeRunSummarySchema>;
export type ResourceGroupObservation = z.infer<typeof ResourceGroupObservationSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
