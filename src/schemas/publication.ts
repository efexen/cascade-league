import { z } from "zod";

import {
  GenerationIdSchema,
  RelativePosixPathSchema,
  SchemaVersionSchema,
  SeasonIdSchema,
  uniqueValues,
} from "./common.js";

export const StaticSiteCatalogGenerationSchema = z
  .object({
    seasonId: SeasonIdSchema,
    generationId: GenerationIdSchema,
    path: RelativePosixPathSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    const expected = `seasons/${entry.seasonId}/${entry.generationId}/index.html`;
    if (entry.path !== expected) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: `must equal ${expected}`,
      });
    }
  });

export const StaticSiteCatalogSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    generations: z.array(StaticSiteCatalogGenerationSchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    const keys = catalog.generations.map(
      (entry) => `${entry.seasonId}/${entry.generationId}`,
    );
    if (!uniqueValues(keys)) {
      context.addIssue({
        code: "custom",
        path: ["generations"],
        message: "must contain unique season and generation pairs",
      });
    }
    const sorted = [...keys].sort((left, right) => left.localeCompare(right));
    if (keys.some((key, index) => key !== sorted[index])) {
      context.addIssue({
        code: "custom",
        path: ["generations"],
        message: "must be sorted by season and generation ID",
      });
    }
  });

export type StaticSiteCatalog = z.infer<typeof StaticSiteCatalogSchema>;
export type StaticSiteCatalogGeneration = z.infer<
  typeof StaticSiteCatalogGenerationSchema
>;
