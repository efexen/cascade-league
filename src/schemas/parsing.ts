import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

export function parseJsonWithSchema<T extends z.ZodTypeAny>(
  text: string,
  schema: T,
  source = "JSON",
): z.infer<T> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid ${source}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  return schema.parse(value);
}

export function parseYamlWithSchema<T extends z.ZodTypeAny>(
  text: string,
  schema: T,
  source = "YAML",
): z.infer<T> {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    throw new Error(
      `Invalid ${source}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  return schema.parse(value);
}

export async function readJsonWithSchema<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
): Promise<z.infer<T>> {
  return schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export async function readYamlWithSchema<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
): Promise<z.infer<T>> {
  return schema.parse(parseYaml(await readFile(path, "utf8")));
}
