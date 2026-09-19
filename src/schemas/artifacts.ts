import { z } from "zod";

import { ChallengeConfigSchema } from "./config.js";

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
  publicationSourceNonce: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceTemplate: RelativePosixPathSchema,
  dataSource: SnapshotDataSourceSchema,
  resolvedHtmlPath: RelativePosixPathSchema,
  resolvedHtmlSha256: Sha256Schema,
  inputHashes: z
    .record(RelativePosixPathSchema, Sha256Schema)
    .refine((value) => Object.keys(value).length > 0, "inputHashes must not be empty"),
  assetHashes: z.record(RelativePosixPathSchema, Sha256Schema),
});

const ArchivedSeedEntrySchema = StrictObject({
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase hyphenated slug"),
  screenshotPath: RelativePosixPathSchema.refine(
    (value) => value.startsWith("thumbnails/") && value.endsWith(".png"),
    "seed screenshots must be generation challenge thumbnails",
  ),
  alt: Text(300),
});

const ArchivedSeedDataSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  seasonId: SeasonIdSchema,
  generationId: z.null(),
  generatedAt: UtcTimestampSchema,
  entries: z
    .array(ArchivedSeedEntrySchema)
    .length(6)
    .superRefine((entries, context) => {
      const ids = entries.map((entry) => entry.id);
      const paths = entries.map((entry) => entry.screenshotPath);
      if (!uniqueValues(ids) || !uniqueValues(paths)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "archived seed entry IDs and paths must be unique",
        });
      }
    }),
});

export const GalleryStaticCopySchema = StrictObject({
  descriptor: Text(200),
  shortDescription: Text(500),
  headline: Text(300),
  introduction: Text(1000),
  centralQuestion: Text(500),
  rules: z.array(Text(300)).length(5),
  method: Text(1000),
  statusLabels: StrictObject({
    seed: Text(100),
    valid: Text(100),
    invalid: Text(100),
    timeout: Text(100),
    render_failed: Text(100),
    judge_incomplete: Text(100),
    execution_failed: Text(100),
  }),
  seedEntry: StrictObject({
    displayName: Text(200),
    harnessName: Text(200),
    modelName: Text(200),
    statusLabel: Text(100),
  }),
});

export const GallerySourceArchiveSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  sourceTemplate: RelativePosixPathSchema,
  challengeConfig: ChallengeConfigSchema,
  template: Text(4 * 1024 * 1024),
  staticCopy: GalleryStaticCopySchema,
  seed: ArchivedSeedDataSchema,
});

export type GalleryStaticCopy = z.infer<typeof GalleryStaticCopySchema>;
export type GallerySourceArchive = z.infer<typeof GallerySourceArchiveSchema>;

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
    family: Text(200).optional(),
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
    // Phase 2 §6.7: these are *observed* values reported by the harness
    // wrapper's private execution metadata. They are deliberately separate
    // from the configured identity in `identity.json` and stay `null` when
    // the wrapper produced no (or no complete) metadata. Archived Phase 1
    // artifacts carry non-null strings and continue to parse.
    harness: Text(200).nullable(),
    model: Text(200).nullable(),
  }),
  stdoutLog: RelativePosixPathSchema,
  stderrLog: RelativePosixPathSchema,
  error: z.string().max(4000).nullable(),
});

export const TaskRoleSchema = z.enum(["contestant", "render", "judge", "awards"]);

export const TaskStateStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "missing_submission",
  "invalid",
  "uncertain",
]);

export const TaskStateSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  taskId: TaskIdSchema,
  role: TaskRoleSchema,
  targetId: Text(200),
  status: TaskStateStatusSchema,
  startedAt: OptionalTimestampSchema,
  completedAt: OptionalTimestampSchema,
  attemptCount: NonNegativeIntegerSchema,
  requestAccepted: z.boolean().nullable(),
  error: z.string().max(4000).nullable(),
}).superRefine((task, context) => {
  if (task.status === "running" && task.completedAt !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["completedAt"],
      message: "running tasks must not have completedAt",
    });
  }
  if (task.status !== "pending" && task.startedAt === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["startedAt"],
      message: "started tasks must record startedAt",
    });
  }
  if (
    task.status !== "pending" &&
    task.status !== "running" &&
    task.completedAt === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["completedAt"],
      message: "terminal tasks must record completedAt",
    });
  }
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
  sanitisedSha256: Sha256Schema.nullable(),
  submissionBytes: NonNegativeIntegerSchema,
  staticChecks: z.array(ValidationCheckSchema),
  renderChecks: z.array(ValidationCheckSchema),
  renderEnvironment: StrictObject({
    playwright: Text(100),
    chromium: Text(100),
  }).optional(),
  errors: z.array(z.string().max(2000)),
  warnings: z.array(z.string().max(2000)),
}).superRefine((validation, context) => {
  if (validation.status === "valid" && validation.sanitisedSha256 === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sanitisedSha256"],
      message: "valid submissions must record a sanitised CSS hash",
    });
  }
});

const RandomSeedSchema = z.string().min(1).max(256);

export const ContactSheetOrderSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  generationId: GenerationIdSchema,
  judgeId: JudgeIdSchema,
  seed: RandomSeedSchema,
  candidateOrder: z
    .array(AnonymousCandidateIdSchema)
    .min(1)
    .superRefine((order, context) => {
      if (!uniqueValues(order)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "candidate order must be unique",
        });
      }
    }),
});

export const JudgeAssessmentOrderSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  generationId: GenerationIdSchema,
  judgeId: JudgeIdSchema,
  seed: RandomSeedSchema,
  assessmentOrder: z
    .array(AnonymousCandidateIdSchema)
    .min(1)
    .superRefine((order, context) => {
      if (!uniqueValues(order)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "assessment order must be unique",
        });
      }
    }),
});

const JudgeTaskTimingEntrySchema = StrictObject({
  operation: z.enum(["candidate", "awards"]),
  anonymousCandidateId: AnonymousCandidateIdSchema.nullable(),
  startedAt: UtcTimestampSchema,
  completedAt: UtcTimestampSchema,
  durationMs: NonNegativeIntegerSchema,
}).superRefine((entry, context) => {
  if (entry.operation === "candidate" && entry.anonymousCandidateId === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["anonymousCandidateId"],
      message: "candidate timing must name its anonymous candidate",
    });
  }
  if (entry.operation === "awards" && entry.anonymousCandidateId !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["anonymousCandidateId"],
      message: "awards timing must not name a candidate",
    });
  }
  const duration = Date.parse(entry.completedAt) - Date.parse(entry.startedAt);
  if (duration !== entry.durationMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["durationMs"],
      message: "timing duration must equal completion minus start",
    });
  }
});

export const JudgeTaskTimingsSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  generationId: GenerationIdSchema,
  judgeId: JudgeIdSchema,
  tasks: z.array(JudgeTaskTimingEntrySchema).min(1),
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

export const MAX_JUDGMENT_TEXT_CHARACTERS = 500;

const UnboundedText = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "must not be blank");

function requireCritiqueSentenceCount(value: string, context: z.RefinementCtx): void {
  const count = sentenceCount(value);
  if (count < 2 || count > 4) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "critique must contain two to four sentences",
    });
  }
}

export const JudgeSummarySchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  generationId: GenerationIdSchema,
  judgeId: JudgeIdSchema,
  entries: z.array(
    StrictObject({
      anonymousCandidateId: AnonymousCandidateIdSchema,
      totalScore: ScoreSchema(100),
      originalityScore: ScoreSchema(20),
      critique: Text(MAX_JUDGMENT_TEXT_CHARACTERS),
    }),
  ),
});

const CandidateJudgmentResponseShape = {
  schemaVersion: SchemaVersionSchema,
  generationId: GenerationIdSchema,
  judgeId: JudgeIdSchema,
  anonymousCandidateId: AnonymousCandidateIdSchema,
  scores: JudgmentScoresSchema,
  totalScore: z.number().int().min(0).max(100),
  critique: Text(MAX_JUDGMENT_TEXT_CHARACTERS).superRefine(
    requireCritiqueSentenceCount,
  ),
  strongestQuality: Text(MAX_JUDGMENT_TEXT_CHARACTERS),
  primaryWeakness: Text(MAX_JUDGMENT_TEXT_CHARACTERS),
  nextMove: Text(MAX_JUDGMENT_TEXT_CHARACTERS),
  confidence: z.enum(["low", "medium", "high"]),
  flags: z.array(SlugLikeCodeSchema()),
};

function withCalculatedJudgmentTotal<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.superRefine((judgment, context) => {
    const typedJudgment = judgment as {
      scores: Record<string, number>;
      totalScore: number;
    };
    const calculatedTotal = Object.values(typedJudgment.scores).reduce(
      (sum, score) => sum + score,
      0,
    );
    if (typedJudgment.totalScore !== calculatedTotal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalScore"],
        message: `totalScore must equal the seven dimension scores (${calculatedTotal})`,
      });
    }
  });
}

export const JudgeCandidateResponseSchema = withCalculatedJudgmentTotal(
  StrictObject(CandidateJudgmentResponseShape),
);

export const JudgeCandidateResponseBeforeTextLimitSchema = withCalculatedJudgmentTotal(
  StrictObject({
    ...CandidateJudgmentResponseShape,
    critique: UnboundedText.superRefine(requireCritiqueSentenceCount),
    strongestQuality: UnboundedText,
    primaryWeakness: UnboundedText,
    nextMove: UnboundedText,
  }),
);

export const CandidateJudgmentSchema = withCalculatedJudgmentTotal(
  StrictObject({
    ...CandidateJudgmentResponseShape,
    modelUsage: StrictObject({
      inputTokens: NonNegativeIntegerSchema.nullable(),
      outputTokens: NonNegativeIntegerSchema.nullable(),
      totalTokens: NonNegativeIntegerSchema.nullable(),
      estimatedCostUsd: NonNegativeNumberSchema.nullable(),
    }),
  }),
);

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
  strongestQuality: Text(500).optional(),
  primaryWeakness: Text(500).optional(),
  nextMove: Text(500).optional(),
  scores: JudgmentScoresSchema.optional(),
  candidateRank: z.number().int().positive().nullable().optional(),
  sameProvider: z.boolean().nullable().optional(),
  sameModelFamily: z.boolean().nullable().optional(),
});

const LeaderboardAwardSchema = StrictObject({
  judgeId: JudgeIdSchema,
  label: Text(50),
  rationale: Text(240),
});

export const LeaderboardDimensionMeansSchema = StrictObject({
  hierarchyAndReadability: z.number().finite().min(0).max(15),
  composition: z.number().finite().min(0).max(15),
  typography: z.number().finite().min(0).max(15),
  colourAndVisualSystem: z.number().finite().min(0).max(10),
  coherenceAndCraft: z.number().finite().min(0).max(15),
  originalityAndMemorability: z.number().finite().min(0).max(20),
  constraintAndCssCraft: z.number().finite().min(0).max(10),
});

const SelfFamilyMetadataSchema = StrictObject({
  providerMatches: NonNegativeIntegerSchema,
  providerComparisons: NonNegativeIntegerSchema,
  modelFamilyMatches: NonNegativeIntegerSchema,
  modelFamilyComparisons: NonNegativeIntegerSchema,
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
  meanHierarchyAndReadability: z.number().finite().min(0).max(15).nullable().optional(),
  minimumScore: z.number().finite().min(0).max(100).nullable().optional(),
  maximumScore: z.number().finite().min(0).max(100).nullable().optional(),
  scoreRange: z.number().finite().min(0).max(100).nullable().optional(),
  standardDeviation: z.number().finite().min(0).max(100).nullable().optional(),
  dimensionMeans: LeaderboardDimensionMeansSchema.nullable().optional(),
  completedJudgeCount: NonNegativeIntegerSchema,
  expectedJudgeCount: NonNegativeIntegerSchema,
  judgeScores: z.array(LeaderboardJudgeScoreSchema),
  judgeRanks: z
    .array(
      StrictObject({
        judgeId: JudgeIdSchema,
        rank: z.number().int().positive(),
      }),
    )
    .optional(),
  selfFamily: SelfFamilyMetadataSchema.optional(),
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
export type TaskState = z.infer<typeof TaskStateSchema>;
export type Validation = z.infer<typeof ValidationSchema>;
export type ContactSheetOrder = z.infer<typeof ContactSheetOrderSchema>;
export type JudgeAssessmentOrder = z.infer<typeof JudgeAssessmentOrderSchema>;
export type JudgeTaskTimings = z.infer<typeof JudgeTaskTimingsSchema>;
export type JudgeSummary = z.infer<typeof JudgeSummarySchema>;
export type CandidateJudgment = z.infer<typeof CandidateJudgmentSchema>;
export type JudgeCandidateResponse = z.infer<typeof JudgeCandidateResponseSchema>;
export type JudgmentScores = z.infer<typeof JudgmentScoresSchema>;
export type GenerationAwards = z.infer<typeof GenerationAwardsSchema>;
export type Leaderboard = z.infer<typeof LeaderboardSchema>;
export type AnonymousMap = z.infer<typeof AnonymousMapSchema>;
