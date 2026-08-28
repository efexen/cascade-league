import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);

export const SeasonIdSchema = z
  .string()
  .regex(/^\d{4}$/, "must be a four-digit season ID");

export const GenerationIdSchema = z
  .string()
  .regex(/^\d{4}$/, "must be a four-digit generation ID");

export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase hyphenated slug");

export const ContestantIdSchema = SlugSchema;
export const JudgeIdSchema = SlugSchema;

export const AnonymousCandidateIdSchema = z
  .string()
  .regex(/^candidate-[a-z0-9]{4,32}$/, "must be a candidate-… anonymous ID");

export const TaskIdSchema = z
  .string()
  .regex(
    /^\d{4}-(?:contestant|judge|awards)-[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must contain a generation, role, and slug",
  );

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 hexadecimal hash");

export const UtcTimestampSchema = z
  .string()
  .datetime({ offset: false })
  .refine((value) => value.endsWith("Z"), "must be an ISO 8601 UTC timestamp");

export const RelativePosixPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.startsWith("/"), "must be relative")
  .refine((value) => !value.includes("\\"), "must use POSIX separators")
  .refine((value) => !value.includes("://"), "must not be a URL")
  .refine((value) => !value.includes(":"), "must not contain a drive prefix")
  .refine(
    (value) =>
      value
        .split("/")
        .every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "must not contain empty, . or .. path segments",
  );

export const PositiveIntegerSchema = z.number().int().positive();
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const NonNegativeNumberSchema = z.number().nonnegative();
export const ReasoningEffortSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const OptionalTimestampSchema = UtcTimestampSchema.nullable();

export function uniqueValues<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

export function wordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

export function sentenceCount(value: string): number {
  return value.trim().match(/[^.!?]+[.!?]+(?=\s|$)/gu)?.length ?? 0;
}

export const JsonPrimitiveSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const JsonValueSchema: z.ZodType<
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
> = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
