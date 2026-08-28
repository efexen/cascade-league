import { z } from "zod";

import {
  ContestantIdSchema,
  GenerationIdSchema,
  JudgeIdSchema,
  RelativePosixPathSchema,
  SchemaVersionSchema,
  SeasonIdSchema,
  SlugSchema,
  UtcTimestampSchema,
  uniqueValues,
} from "../schemas/index.js";
import { JudgmentScoresSchema } from "../schemas/index.js";

const TextSchema = (maximum = 4096) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, "must not be blank");

const DisplayAggregateLabelSchema = z.union([
  z.literal("—"),
  z.string().regex(/^\d+\.\d{2}$/u, "aggregate display values must use two decimals"),
]);

export const DimensionMeanLabelsSchema = z
  .object({
    hierarchyAndReadability: z.string().regex(/^\d+\.\d{2}$/u),
    composition: z.string().regex(/^\d+\.\d{2}$/u),
    typography: z.string().regex(/^\d+\.\d{2}$/u),
    colourAndVisualSystem: z.string().regex(/^\d+\.\d{2}$/u),
    coherenceAndCraft: z.string().regex(/^\d+\.\d{2}$/u),
    originalityAndMemorability: z.string().regex(/^\d+\.\d{2}$/u),
    constraintAndCssCraft: z.string().regex(/^\d+\.\d{2}$/u),
  })
  .strict();

export const SeedEntrySchema = z
  .object({
    id: SlugSchema,
    screenshotPath: RelativePosixPathSchema,
    alt: TextSchema(300),
  })
  .strict();

export const SeedGenerationSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    seasonId: SeasonIdSchema,
    generationId: z.null(),
    generatedAt: UtcTimestampSchema,
    entries: z
      .array(SeedEntrySchema)
      .length(6)
      .superRefine((entries, context) => {
        const ids = entries.map((entry) => entry.id);
        const paths = entries.map((entry) => entry.screenshotPath);
        if (!uniqueValues(ids) || !uniqueValues(paths)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "seed entry IDs and screenshot paths must be unique",
          });
        }
      }),
  })
  .strict();

const JudgeNoteSchema = z
  .object({
    judgeId: JudgeIdSchema,
    judgeDisplayName: TextSchema(200),
    totalScore: z.number().int().min(0).max(100),
    originalityScore: z.number().int().min(0).max(20),
    critique: TextSchema(500),
    strongestQuality: TextSchema(500).optional(),
    primaryWeakness: TextSchema(500).optional(),
    nextMove: TextSchema(500).optional(),
    scores: JudgmentScoresSchema.optional(),
    candidateRank: z.number().int().positive().nullable().optional(),
  })
  .strict();

const PageAwardSchema = z
  .object({
    label: TextSchema(50),
    anonymousCandidateId: z.string().min(1),
    winningDisplayName: TextSchema(200),
    judgeId: JudgeIdSchema,
    judgeDisplayName: TextSchema(200),
    rationale: TextSchema(240),
  })
  .strict();

const PageEntrySchema = z
  .object({
    id: z.union([ContestantIdSchema, SlugSchema]),
    rank: z.number().int().positive().nullable(),
    displayName: TextSchema(200),
    harnessName: TextSchema(200),
    modelName: TextSchema(200),
    status: z.enum([
      "seed",
      "valid",
      "invalid",
      "timeout",
      "render_failed",
      "judge_incomplete",
      "execution_failed",
    ]),
    statusLabel: TextSchema(100),
    alt: TextSchema(300),
    screenshotPath: RelativePosixPathSchema,
    combinedScoreLabel: DisplayAggregateLabelSchema,
    originalityScoreLabel: DisplayAggregateLabelSchema,
    completedJudgeCount: z.number().int().nonnegative(),
    expectedJudgeCount: z.number().int().nonnegative(),
    dimensionMeanLabels: DimensionMeanLabelsSchema.nullable().optional(),
    judgeScores: z.array(JudgeNoteSchema),
    awards: z.array(
      z
        .object({
          label: TextSchema(50),
        })
        .strict(),
    ),
    failure: z.string().max(4000).nullable(),
  })
  .strict();

export const ChallengePageDataSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    seasonId: SeasonIdSchema,
    seasonLabel: z.string().regex(/^\d{3}$/),
    generationId: GenerationIdSchema,
    title: TextSchema(200),
    descriptor: TextSchema(200),
    shortDescription: TextSchema(500),
    statusBadge: TextSchema(100),
    headline: TextSchema(300),
    introduction: TextSchema(1000),
    centralQuestion: TextSchema(500),
    rules: z.array(TextSchema(300)).length(5),
    entries: z.array(PageEntrySchema).min(1),
    awards: z.array(PageAwardSchema).max(3 * 6),
    method: TextSchema(1000),
    generationTimestamp: TextSchema(100),
    challengeVersion: TextSchema(100),
    renderingEnvironmentVersion: TextSchema(200),
    stylesheetPath: RelativePosixPathSchema,
  })
  .strict();

export type SeedEntry = z.infer<typeof SeedEntrySchema>;
export type SeedGeneration = z.infer<typeof SeedGenerationSchema>;
export type ChallengePageData = z.infer<typeof ChallengePageDataSchema>;
export type PageEntry = ChallengePageData["entries"][number];
export type PageAward = ChallengePageData["awards"][number];
export type DimensionMeanLabels = z.infer<typeof DimensionMeanLabelsSchema>;
