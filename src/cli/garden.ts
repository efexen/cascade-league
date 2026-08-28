#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";

import { createGeneration } from "../artifacts/generation.js";
import { runWaveB } from "../orchestration/wave-b.js";
import {
  normalizeGenerationId,
  normalizeSeasonId,
  verifyRepository,
} from "./commands.js";

const program = new Command();

program.name("garden").description("Local Maxima generation tools").version("0.1.0");

program
  .command("verify")
  .description("Verify the local runtime and repository inputs")
  .action(async () => {
    const report = await verifyRepository(process.cwd());
    if (report.issues.length === 0) {
      console.log("Local Maxima verification passed.");
      return;
    }
    for (const entry of report.issues) {
      console.error(`[${entry.severity}] ${entry.code}: ${entry.message}`);
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
  });

program
  .command("create-generation")
  .description("Create one immutable generation snapshot")
  .requiredOption(
    "--season <season>",
    "three-digit season alias or four-digit season ID",
  )
  .option("--generation <generation>", "explicit four-digit generation ID")
  .action(async (options: { season: string; generation?: string }) => {
    const result = await createGeneration({
      repositoryRoot: process.cwd(),
      seasonId: normalizeSeasonId(options.season),
      ...(options.generation === undefined
        ? {}
        : { generationId: normalizeGenerationId(options.generation) }),
    });
    console.log(
      `[${result.generationId}] generation created: ${result.generationPath}`,
    );
  });

program
  .command("run-wave-b")
  .description("Run contestants, validation, rendering, anonymous judging, and awards")
  .option("--season <season>", "three-digit season alias or four-digit season ID")
  .option("--generation <generation>", "accept an existing four-digit generation ID")
  .option("--generation-path <path>", "accept an existing generation directory")
  .option("--generations-root <path>", "root directory for newly created generations")
  .action(
    async (options: {
      season?: string;
      generation?: string;
      generationPath?: string;
      generationsRoot?: string;
    }) => {
      const seasonId =
        options.season === undefined ? undefined : normalizeSeasonId(options.season);
      const generationId =
        options.generation === undefined
          ? undefined
          : normalizeGenerationId(options.generation);
      if (options.generationPath !== undefined && generationId !== undefined) {
        throw new Error("use either --generation or --generation-path, not both");
      }
      if (
        seasonId === undefined &&
        options.generationPath === undefined &&
        generationId === undefined
      ) {
        throw new Error(
          "--season is required when creating a generation; otherwise provide --generation or --generation-path",
        );
      }
      const existingGenerationPath =
        options.generationPath === undefined &&
        seasonId === undefined &&
        generationId !== undefined
          ? resolve(options.generationsRoot ?? "generations", generationId)
          : options.generationPath === undefined
            ? undefined
            : resolve(options.generationPath);
      const result = await runWaveB({
        repositoryRoot: process.cwd(),
        ...(seasonId === undefined ? {} : { seasonId }),
        ...(existingGenerationPath === undefined
          ? {}
          : { generationPath: existingGenerationPath }),
        ...(options.generationsRoot === undefined
          ? {}
          : { generationsRoot: resolve(options.generationsRoot) }),
        ...(generationId === undefined ? {} : { generationId }),
        onProgress: (message) => console.log(message),
      });
      console.log(`[${result.generationId}] Wave-B complete: ${result.generationPath}`);
    },
  );

await program.parseAsync(process.argv);
