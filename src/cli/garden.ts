#!/usr/bin/env node

import { Command } from "commander";

import { createGeneration } from "../artifacts/generation.js";
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

await program.parseAsync(process.argv);
