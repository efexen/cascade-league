import { z } from "zod";

import {
  ContestantIdSchema,
  JudgeIdSchema,
  PositiveIntegerSchema,
  RelativePosixPathSchema,
  ReasoningEffortSchema,
  SchemaVersionSchema,
  SeasonIdSchema,
  SlugSchema,
  uniqueValues,
} from "./common.js";

const NonEmptyTextSchema = (maximum = 4096) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, "must not be blank");

const EnvironmentVariableNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name");

const PlaceholderSchema = z
  .string()
  .regex(/^\{[a-zA-Z][a-zA-Z0-9]*Path\}$/, "invalid placeholder");

export const ContestantCommandPlaceholders = [
  "{workspacePath}",
  "{challengePath}",
  "{starterCssPath}",
  "{promptPath}",
  "{submissionPath}",
  "{usageOutputPath}",
] as const;

export const JudgeCommandPlaceholders = [
  "{workspacePath}",
  "{promptPath}",
  "{candidateScreenshotPath}",
  "{contactSheetPath}",
  "{sanitisedCssPath}",
  "{judgmentPath}",
  "{usageOutputPath}",
  "{judgmentSummaryPath}",
  "{awardsPath}",
] as const;

function commandSchema(allowedPlaceholders: readonly string[]) {
  return z
    .object({
      argv: z.array(NonEmptyTextSchema(4096)).min(1),
      environmentAllowlist: z
        .array(EnvironmentVariableNameSchema)
        .superRefine((values, context) => {
          if (!uniqueValues(values)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "environment allowlist must not contain duplicates",
            });
          }
        }),
    })
    .strict()
    .superRefine((command, context) => {
      const executable = command.argv[0];
      if (executable === undefined || !executable.startsWith("/")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["argv", 0],
          message: "the executable path must be absolute",
        });
      }

      command.argv.forEach((argument, index) => {
        if (/[;&|`\r\n]|\$\(/u.test(argument)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["argv", index],
            message: "shell fragments are not allowed in argv values",
          });
        }
        const placeholders = argument.match(/\{[^{}]+\}/g) ?? [];
        if (
          placeholders.length === 0 &&
          !argument.includes("{") &&
          !argument.includes("}")
        ) {
          return;
        }

        if (
          placeholders.length !== 1 ||
          argument !== placeholders[0] ||
          !allowedPlaceholders.includes(argument)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["argv", index],
            message: "placeholders must be complete values from the adapter allowlist",
          });
        }
      });
    });
}

const BaseHarnessSchema = z
  .object({
    name: NonEmptyTextSchema(200),
    version: NonEmptyTextSchema(200).optional(),
  })
  .strict();

const ContestantCommandHarnessSchema = BaseHarnessSchema.extend({
  adapter: z.literal("command"),
  command: commandSchema(ContestantCommandPlaceholders),
}).strict();

const ContestantFixtureHarnessSchema = BaseHarnessSchema.extend({
  adapter: z.literal("fixture"),
  fixture: SlugSchema,
}).strict();

export const ContestantHarnessSchema = z.discriminatedUnion("adapter", [
  ContestantCommandHarnessSchema,
  ContestantFixtureHarnessSchema,
]);

const JudgeCommandHarnessSchema = BaseHarnessSchema.extend({
  adapter: z.literal("command"),
  command: commandSchema(JudgeCommandPlaceholders),
}).strict();

const JudgeFixtureHarnessSchema = BaseHarnessSchema.extend({
  adapter: z.literal("fixture"),
  fixture: SlugSchema,
}).strict();

export const JudgeHarnessSchema = z.discriminatedUnion("adapter", [
  JudgeCommandHarnessSchema,
  JudgeFixtureHarnessSchema,
]);

const ModelSchema = z
  .object({
    provider: NonEmptyTextSchema(200),
    name: NonEmptyTextSchema(200),
    version: NonEmptyTextSchema(200),
    family: NonEmptyTextSchema(200).optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
  })
  .strict();

const ContestantBudgetSchema = z
  .object({
    timeoutMs: PositiveIntegerSchema,
    maximumTotalTokens: PositiveIntegerSchema,
  })
  .strict();

const JudgeBudgetSchema = z
  .object({
    timeoutMs: PositiveIntegerSchema,
    maximumOutputTokens: PositiveIntegerSchema,
  })
  .strict();

export const ChallengeConfigSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    seasonId: SeasonIdSchema,
    title: NonEmptyTextSchema(200),
    challengeVersion: NonEmptyTextSchema(100),
    template: RelativePosixPathSchema,
    starterCss: RelativePosixPathSchema,
    fallbackCss: RelativePosixPathSchema,
    seedData: RelativePosixPathSchema,
    viewport: z
      .object({
        width: z.literal(1440),
        height: z.literal(1200),
        deviceScaleFactor: z.literal(1),
      })
      .strict(),
    browser: z
      .object({
        engine: z.literal("chromium"),
        colorScheme: z.literal("light"),
        reducedMotion: z.literal("reduce"),
        locale: z.literal("en-GB"),
        timezoneId: z.literal("UTC"),
        javaScriptEnabled: z.literal(false),
      })
      .strict(),
    submission: z
      .object({
        filename: z.literal("submission.css"),
        maximumBytes: PositiveIntegerSchema.max(61440),
        allowImports: z.literal(false),
        allowRemoteUrls: z.literal(false),
        allowDataUrls: z.literal(false),
      })
      .strict(),
    requiredSelectors: z
      .array(NonEmptyTextSchema(512))
      .min(1)
      .superRefine((values, context) => {
        if (!uniqueValues(values)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "required selectors must not be duplicated",
          });
        }
      }),
  })
  .strict();

const ContestantSchema = z
  .object({
    id: ContestantIdSchema,
    displayName: NonEmptyTextSchema(200),
    harness: ContestantHarnessSchema,
    model: ModelSchema,
    budget: ContestantBudgetSchema.optional(),
    enabled: z.boolean(),
  })
  .strict();

export const ContestantsConfigSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    defaults: z
      .object({
        timeoutMs: PositiveIntegerSchema,
        maximumTotalTokens: PositiveIntegerSchema,
        maximumSubmissionBytes: PositiveIntegerSchema.max(61440),
        concurrency: PositiveIntegerSchema.max(4),
      })
      .strict(),
    contestants: z.array(ContestantSchema).min(2).max(6),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = config.contestants.map((contestant) => contestant.id);
    if (!uniqueValues(ids)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contestants"],
        message: "contestant IDs must be unique",
      });
    }
  });

const JudgeSchema = z
  .object({
    id: JudgeIdSchema,
    displayName: NonEmptyTextSchema(200),
    harness: JudgeHarnessSchema,
    model: ModelSchema,
    budget: JudgeBudgetSchema.optional(),
    enabled: z.boolean(),
  })
  .strict();

export const JudgesConfigSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    defaults: z
      .object({
        timeoutMs: PositiveIntegerSchema,
        maximumOutputTokens: PositiveIntegerSchema,
        concurrencyPerJudge: PositiveIntegerSchema.max(2),
      })
      .strict(),
    judges: z.array(JudgeSchema).min(1),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = config.judges.map((judge) => judge.id);
    if (!uniqueValues(ids)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["judges"],
        message: "judge IDs must be unique",
      });
    }
  });

export type ChallengeConfig = z.infer<typeof ChallengeConfigSchema>;
export type ContestantsConfig = z.infer<typeof ContestantsConfigSchema>;
export type JudgesConfig = z.infer<typeof JudgesConfigSchema>;
export type ContestantConfig = ContestantsConfig["contestants"][number];
export type JudgeConfig = JudgesConfig["judges"][number];
export type ContestantCommand = z.infer<ReturnType<typeof commandSchema>>;

// Keep the placeholder shape checked at schema construction time as well as at
// parse time. This makes accidental changes to the allowlist visible to tests.
export const PlaceholderShapeSchema = PlaceholderSchema;
