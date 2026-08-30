import { z } from "zod";

import {
  ContestantIdSchema,
  GenerationIdSchema,
  JudgeIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  ProfileIdSchema,
  SchemaVersionSchema,
  SeasonIdSchema,
  Sha256Schema,
  SlugSchema,
} from "./common.js";

const StrictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const Text = (maximum = 4096) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, "must not be blank");

const RunPlanIdentitySchema = StrictObject({
  id: SlugSchema,
  displayName: Text(200),
});

const RunPlanCallCountsSchema = StrictObject({
  contestantCalls: NonNegativeIntegerSchema,
  candidateJudgingCalls: NonNegativeIntegerSchema,
  awardsCalls: NonNegativeIntegerSchema,
  maximumTotalCalls: NonNegativeIntegerSchema,
});

const RunPlanContestantCeilingSchema = StrictObject({
  id: ContestantIdSchema,
  timeoutMs: PositiveIntegerSchema,
  maximumTotalTokens: PositiveIntegerSchema,
});

const RunPlanJudgeCeilingSchema = StrictObject({
  id: JudgeIdSchema,
  timeoutMs: PositiveIntegerSchema,
  maximumOutputTokens: PositiveIntegerSchema,
});

const RunPlanResourceGroupSchema = StrictObject({
  maximumConcurrency: PositiveIntegerSchema,
  minimumStartIntervalMs: NonNegativeIntegerSchema,
  entryIds: z.array(SlugSchema),
});

const RunPlanConfigSnapshotHashesSchema = StrictObject({
  "config/contestants.yaml": Sha256Schema,
  "config/judges.yaml": Sha256Schema,
  "config/profile.json": Sha256Schema,
});

// The durable private `run-plan.json` artifact. `schemaVersion` is the plan
// artifact version, independent of the run-configuration schema versions it
// describes. The plan contains no timestamps so identical inputs serialise
// byte-identically.
export const RunPlanSchema = StrictObject({
  schemaVersion: SchemaVersionSchema,
  seasonId: SeasonIdSchema,
  generationId: GenerationIdSchema,
  previousGenerationId: GenerationIdSchema.nullable(),
  profileId: ProfileIdSchema,
  contestants: z.array(RunPlanIdentitySchema),
  judges: z.array(RunPlanIdentitySchema),
  externalModelCallsRequired: z.boolean(),
  callCounts: RunPlanCallCountsSchema,
  ceilings: StrictObject({
    contestants: z.array(RunPlanContestantCeilingSchema),
    judges: z.array(RunPlanJudgeCeilingSchema),
  }),
  resourceGroups: z.record(SlugSchema, RunPlanResourceGroupSchema),
  usageReportingUnsupported: z.array(SlugSchema),
  promptOnlyOneShot: z.array(SlugSchema),
  promptOnlyOneShotAccepted: z.boolean(),
  configSnapshotHashes: RunPlanConfigSnapshotHashesSchema,
});

export type RunPlan = z.infer<typeof RunPlanSchema>;
