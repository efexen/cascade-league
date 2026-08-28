import { z } from "zod";

import {
  AnonymousCandidateIdSchema,
  ContestantIdSchema,
  GenerationIdSchema,
  JudgeIdSchema,
  JsonValueSchema,
  NonNegativeIntegerSchema,
  NonNegativeNumberSchema,
  OptionalTimestampSchema,
  PositiveIntegerSchema,
  RelativePosixPathSchema,
  ReasoningEffortSchema,
  SchemaVersionSchema,
  SeasonIdSchema,
  Sha256Schema,
  TaskIdSchema,
  UtcTimestampSchema,
  sentenceCount,
  uniqueValues,
  wordCount,
} from "./common.js";

const StrictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const Text = (maximum = 4096) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, "must not be blank");

const ConfigHashesSchema = StrictObject({
  challenge: Sha256Schema,
  contestants: Sha256Schema,
  judges: Sha256Schema,
});

const EnvironmentSchema = StrictObject({
  os: Text(100),
  architecture: Text(100),
  nodeVersion: Text(100),
  playwrightVersion: Text(100),
  chromiumVersion: Text(100),
});

export const GenerationStatusSchema = z.enum([
  "created",
  "snapshot_ready",
  "contestants_running",
  "contestants_complete",
  "renders_complete",
  "judging_complete",
  "scored",
  "gallery_complete",
  "completed",
]);

export const ManifestSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  seasonId: SeasonIdSchema,
  generationId: GenerationIdSchema,
  status: GenerationStatusSchema,
  createdAt: UtcTimestampSchema,
  startedAt: OptionalTimestampSchema,
  completedAt: OptionalTimestampSchema,
  previousGenerationId: GenerationIdSchema.nullable(),
  challengeVersion: Text(100),
  configHashes: ConfigHashesSchema,
  environment: EnvironmentSchema,
  contestantIds: z.array(ContestantIdSchema).superRefine((values, context) => {
    if (!uniqueValues(values)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "contestant IDs must be unique",
      });
    }
  }),
  judgeIds: z.array(JudgeIdSchema).superRefine((values, context) => {
    if (!uniqueValues(values)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "judge IDs must be unique",
      });
    }
  }),
  errors: z.array(z.string().max(2000)),
});

const SeedDataSourceSchema = StrictObject({
  kind: z.literal("seed"),
  generationId: z.null(),
  path: RelativePosixPathSchema,
});

const PreviousGenerationDataSourceSchema = StrictObject({
  kind: z.literal("previous_generation"),
  generationId: GenerationIdSchema,
  path: RelativePosixPathSchema,
});

export const SnapshotDataSourceSchema = z.discriminatedUnion("kind", [
  SeedDataSourceSchema,
  PreviousGenerationDataSourceSchema,
]);

export const SnapshotSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  sourceTemplate: RelativePosixPathSchema,
  dataSource: SnapshotDataSourceSchema,
  resolvedHtmlPath: RelativePosixPathSchema,
  resolvedHtmlSha256: Sha256Schema,
  inputHashes: z
    .record(RelativePosixPathSchema, Sha256Schema)
    .refine((value) => Object.keys(value).length > 0, "inputHashes must not be empty"),
  assetHashes: z.record(RelativePosixPathSchema, Sha256Schema),
});

export const IdentitySchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  contestantId: ContestantIdSchema,
  anonymousCandidateId: AnonymousCandidateIdSchema,
  displayName: Text(200),
  harness: StrictObject({
    name: Text(200),
    configuredVersion: Text(200),
  }),
  model: StrictObject({
    provider: Text(200),
    name: Text(200),
    configuredVersion: Text(200),
    reasoningEffort: ReasoningEffortSchema.optional(),
  }),
});

const UsageSchema = StrictObject({
  inputTokens: NonNegativeIntegerSchema.nullable(),
  outputTokens: NonNegativeIntegerSchema.nullable(),
  reasoningTokens: NonNegativeIntegerSchema.nullable(),
  totalTokens: NonNegativeIntegerSchema.nullable(),
  estimatedCostUsd: NonNegativeNumberSchema.nullable(),
  tokenLimitEnforced: z.boolean(),
});

const ConfiguredBudgetSchema = StrictObject({
  timeoutMs: PositiveIntegerSchema,
  maximumTotalTokens: PositiveIntegerSchema,
});

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "missing_submission",
  "uncertain",
]);

export const RunSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  taskId: TaskIdSchema,
  status: RunStatusSchema,
  startedAt: OptionalTimestampSchema,
  completedAt: OptionalTimestampSchema,
  durationMs: NonNegativeIntegerSchema.nullable(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  attemptCount: NonNegativeIntegerSchema,
  configuredBudget: ConfiguredBudgetSchema,
  usage: UsageSchema,
  observedVersions: StrictObject({
    harness: Text(200),
    model: Text(200),
  }),
  stdoutLog: RelativePosixPathSchema,
  stderrLog: RelativePosixPathSchema,
  error: z.string().max(4000).nullable(),
});

export const CheckStatusSchema = z.enum(["passed", "warning", "failed", "not_run"]);

export const ValidationCheckSchema = StrictObject({
  code: SlugLikeCodeSchema(),
  status: CheckStatusSchema,
  value: JsonValueSchema.optional(),
  message: Text(2000),
});

function SlugLikeCodeSchema() {
  return z.string().regex(/^[a-z0-9][a-z0-9_:-]*$/);
}

export const ValidationStatusSchema = z.enum(["valid", "invalid", "render_failed"]);

export const ValidationSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  status: ValidationStatusSchema,
  submissionSha256: Sha256Schema.nullable(),
  submissionBytes: NonNegativeIntegerSchema,
  staticChecks: z.array(ValidationCheckSchema),
  renderChecks: z.array(ValidationCheckSchema),
  errors: z.array(z.string().max(2000)),
  warnings: z.array(z.string().max(2000)),
});

const ScoreSchema = (maximum: number) => z.number().int().min(0).max(maximum);

export const JudgmentScoresSchema = StrictObject({
  hierarchyAndReadability: ScoreSchema(15),
  composition: ScoreSchema(15),
  typography: ScoreSchema(15),
  colourAndVisualSystem: ScoreSchema(10),
  coherenceAndCraft: ScoreSchema(15),
  originalityAndMemorability: ScoreSchema(20),
  constraintAndCssCraft: ScoreSchema(10),
});

export const CandidateJudgmentSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  generationId: GenerationIdSchema,
  judgeId: JudgeIdSchema,
  anonymousCandidateId: AnonymousCandidateIdSchema,
  scores: JudgmentScoresSchema,
  totalScore: z.number().int().min(0).max(100),
  critique: Text(500).superRefine((value, context) => {
    const count = sentenceCount(value);
    if (count < 2 || count > 4) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "critique must contain two to four sentences",
      });
    }
  }),
  strongestQuality: Text(500),
  primaryWeakness: Text(500),
  nextMove: Text(500),
  confidence: z.enum(["low", "medium", "high"]),
  flags: z.array(SlugLikeCodeSchema()),
  modelUsage: StrictObject({
    inputTokens: NonNegativeIntegerSchema.nullable(),
    outputTokens: NonNegativeIntegerSchema.nullable(),
    totalTokens: NonNegativeIntegerSchema.nullable(),
    estimatedCostUsd: NonNegativeNumberSchema.nullable(),
  }),
}).superRefine((judgment, context) => {
  const calculatedTotal = Object.values(judgment.scores).reduce(
    (sum, score) => sum + score,
    0,
  );
  if (judgment.totalScore !== calculatedTotal) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["totalScore"],
      message: `totalScore must equal the seven dimension scores (${calculatedTotal})`,
    });
  }
});

const AwardItemSchema = StrictObject({
  label: Text(50).superRefine((value, context) => {
    const count = wordCount(value);
    if (count < 2 || count > 5) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "award labels must contain two to five words",
      });
    }
  }),
  anonymousCandidateId: AnonymousCandidateIdSchema,
  rationale: Text(240).superRefine((value, context) => {
    if (sentenceCount(value) !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "award rationale must contain exactly one sentence",
      });
    }
  }),
});

export const GenerationAwardsSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  generationId: GenerationIdSchema,
  judgeId: JudgeIdSchema,
  awards: z.array(AwardItemSchema).max(3),
});

export function createGenerationAwardsSchema(knownCandidateIds: readonly string[]) {
  return GenerationAwardsSchema.superRefine((value, context) => {
    value.awards.forEach((award, index) => {
      if (!knownCandidateIds.includes(award.anonymousCandidateId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["awards", index, "anonymousCandidateId"],
          message: "award refers to an unknown anonymous candidate",
        });
      }
    });
  });
}

export function parseGenerationAwards(
  value: unknown,
  knownCandidateIds: readonly string[],
): GenerationAwards {
  return createGenerationAwardsSchema(knownCandidateIds).parse(value);
}

export const LeaderboardStatusSchema = z.enum([
  "valid",
  "invalid",
  "timeout",
  "render_failed",
  "judge_incomplete",
  "execution_failed",
]);

const LeaderboardJudgeScoreSchema = StrictObject({
  judgeId: JudgeIdSchema,
  totalScore: ScoreSchema(100),
  originalityScore: ScoreSchema(20),
  critique: Text(500),
});

const LeaderboardAwardSchema = StrictObject({
  judgeId: JudgeIdSchema,
  label: Text(50),
  rationale: Text(240),
});

const LeaderboardEntrySchema = StrictObject({
  rank: z.number().int().positive().nullable(),
  contestantId: ContestantIdSchema,
  displayName: Text(200),
  harnessName: Text(200),
  modelName: Text(200),
  status: LeaderboardStatusSchema,
  screenshotPath: RelativePosixPathSchema.nullable(),
  combinedScore: z.number().finite().min(0).max(100).nullable(),
  medianScore: z.number().finite().min(0).max(100).nullable(),
  originalityScore: z.number().finite().min(0).max(20).nullable(),
  completedJudgeCount: NonNegativeIntegerSchema,
  expectedJudgeCount: NonNegativeIntegerSchema,
  judgeScores: z.array(LeaderboardJudgeScoreSchema),
  awards: z.array(LeaderboardAwardSchema),
  failure: z.string().max(4000).nullable(),
}).superRefine((entry, context) => {
  if (
    entry.screenshotPath !== null &&
    entry.screenshotPath !== `contestants/${entry.contestantId}/screenshot.png`
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["screenshotPath"],
      message: "screenshotPath must be contestants/<contestantId>/screenshot.png",
    });
  }
  if (entry.completedJudgeCount > entry.expectedJudgeCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["completedJudgeCount"],
      message: "completedJudgeCount must not exceed expectedJudgeCount",
    });
  }
});

export const LeaderboardSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  seasonId: SeasonIdSchema,
  generationId: GenerationIdSchema,
  generatedAt: UtcTimestampSchema,
  rankingMethod: z.literal("mean-valid-judge-score-v1"),
  expectedJudgeCount: NonNegativeIntegerSchema,
  entries: z.array(LeaderboardEntrySchema),
}).superRefine((leaderboard, context) => {
  const ids = leaderboard.entries.map((entry) => entry.contestantId);
  if (!uniqueValues(ids)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "leaderboard contestant IDs must be unique",
    });
  }
});

const BriefingCritiqueSchema = StrictObject({
  judgeDisplayName: Text(200),
  totalScore: ScoreSchema(100),
  critique: Text(500),
});

const BriefingAwardSchema = StrictObject({
  judgeId: JudgeIdSchema,
  label: Text(50),
  rationale: Text(240),
});

export const FutureGenerationBriefingSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  seasonId: SeasonIdSchema,
  generationId: GenerationIdSchema,
  contestantId: ContestantIdSchema,
  previous: StrictObject({
    generationId: GenerationIdSchema,
    rank: z.number().int().positive().nullable(),
    combinedScore: z.number().finite(),
    originalityScore: z.number().finite(),
    cssPath: RelativePosixPathSchema,
    screenshotPath: RelativePosixPathSchema,
    critiques: z.array(BriefingCritiqueSchema),
    awards: z.array(BriefingAwardSchema),
  }),
  cohort: StrictObject({
    standings: z.array(
      StrictObject({
        rank: z.number().int().positive(),
        displayName: Text(200),
        combinedScore: z.number().finite(),
        originalityScore: z.number().finite(),
      }),
    ),
    contactSheetPath: RelativePosixPathSchema,
  }),
  instructions: StrictObject({
    mayInspectCompetitorCss: z.literal(false),
    mayInspectFullCompetitorScreenshots: z.literal(false),
    mustProduceSingleCssSubmission: z.literal(true),
  }),
});

export const AnonymousMapSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  generationId: GenerationIdSchema,
  entries: z
    .array(
      StrictObject({
        contestantId: ContestantIdSchema,
        anonymousCandidateId: AnonymousCandidateIdSchema,
      }),
    )
    .superRefine((entries, context) => {
      const anonymousIds = entries.map((entry) => entry.anonymousCandidateId);
      const contestantIds = entries.map((entry) => entry.contestantId);
      if (!uniqueValues(anonymousIds) || !uniqueValues(contestantIds)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "anonymous map IDs must be unique",
        });
      }
    }),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Identity = z.infer<typeof IdentitySchema>;
export type Run = z.infer<typeof RunSchema>;
export type Validation = z.infer<typeof ValidationSchema>;
export type CandidateJudgment = z.infer<typeof CandidateJudgmentSchema>;
export type GenerationAwards = z.infer<typeof GenerationAwardsSchema>;
export type Leaderboard = z.infer<typeof LeaderboardSchema>;
export type AnonymousMap = z.infer<typeof AnonymousMapSchema>;
