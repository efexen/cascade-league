#!/usr/bin/env node

import { Command } from "commander";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createGeneration } from "../artifacts/generation.js";
import { listCheckedInProfiles } from "../config/profiles.js";
import { buildGallery } from "../gallery/index.js";
import { runGeneration } from "../orchestration/generation.js";
import { runWaveB } from "../orchestration/wave-b.js";
import { startLoopbackStaticServer } from "../rendering/index.js";
import { summarizeGeneration } from "../summarize/index.js";
import { formatRunPlan, planGeneration } from "./planning.js";
import {
  normalizeGenerationId,
  normalizeSeasonId,
  verifyRepository,
} from "./commands.js";

const program = new Command();

// fixture-tournament is the one command that never needs --profile: it always
// runs against the checked-in "fixture" profile.
const FIXTURE_PROFILE_ID = "fixture";

interface GenerationLocationOptions {
  readonly generation?: string;
  readonly generationPath?: string;
  readonly generationsRoot?: string;
}

async function requireProfile(
  commandName: string,
  profile: string | undefined,
): Promise<string> {
  if (profile !== undefined) return profile;
  const checkedIn = await listCheckedInProfiles(process.cwd());
  throw new Error(
    `--profile is required for ${commandName}; checked-in profiles: ${
      checkedIn.length > 0
        ? checkedIn.join(", ")
        : "(none found under config/profiles/)"
    }`,
  );
}

function existingGenerationPath(options: GenerationLocationOptions): string {
  if (options.generation !== undefined && options.generationPath !== undefined) {
    throw new Error("use either --generation or --generation-path, not both");
  }
  if (options.generationPath !== undefined) return resolve(options.generationPath);
  if (options.generation !== undefined) {
    return resolve(
      options.generationsRoot ?? "generations",
      normalizeGenerationId(options.generation),
    );
  }
  throw new Error("provide --generation or --generation-path");
}

function progress(): (message: string) => void {
  return (message) => console.log(message);
}

/** One readable line, whitespace-collapsed and truncated, for operator stderr. */
function boundedErrorMessage(error: unknown, maximumCharacters = 600): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, " ")
    .trim();
  return message.length <= maximumCharacters
    ? message
    : `${message.slice(0, maximumCharacters - 1)}…`;
}

program.name("garden").description("Local Maxima generation tools").version("0.1.0");

program
  .command("verify")
  .description("Verify the local runtime and repository inputs")
  .option("--profile <profile>", "configuration profile under config/profiles/")
  .action(async (options: { readonly profile?: string }) => {
    const profileId = await requireProfile("verify", options.profile);
    const report = await verifyRepository(process.cwd(), profileId);
    if (report.ok) {
      console.log("Local Maxima verification passed.");
    }
    for (const entry of report.issues) {
      console.error(`[${entry.severity}] ${entry.code}: ${entry.message}`);
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
  });

program
  .command("plan-generation")
  .description(
    "Preview and validate the next generation without writing anything or calling models",
  )
  .requiredOption(
    "--season <season>",
    "three-digit season alias or four-digit season ID",
  )
  .option("--profile <profile>", "configuration profile under config/profiles/")
  .option("--generations-root <path>", "root directory for generations")
  .option(
    "--accept-prompt-only-one-shot",
    "explicitly accept prompt-only one-shot enforcement for command contestants",
  )
  .action(
    async (options: {
      season: string;
      profile?: string;
      generationsRoot?: string;
      acceptPromptOnlyOneShot?: boolean;
    }) => {
      const profileId = await requireProfile("plan-generation", options.profile);
      const outcome = await planGeneration({
        repositoryRoot: process.cwd(),
        seasonId: normalizeSeasonId(options.season),
        profileId,
        ...(options.generationsRoot === undefined
          ? {}
          : { generationsRoot: resolve(options.generationsRoot) }),
        acceptPromptOnlyOneShot: options.acceptPromptOnlyOneShot === true,
      });
      for (const entry of outcome.report.issues) {
        console.error(`[${entry.severity}] ${entry.code}: ${entry.message}`);
      }
      if (!outcome.report.ok) {
        console.error("plan-generation refused: preflight reported errors.");
        process.exitCode = 1;
        return;
      }
      if (outcome.promptOnlyRefusal.length > 0) {
        console.error(
          `plan-generation refused: ${String(outcome.promptOnlyRefusal.length)} enabled command contestant(s) rely on prompt-only one-shot enforcement: ${outcome.promptOnlyRefusal.join(", ")}`,
        );
        console.error(
          "rerun with --accept-prompt-only-one-shot to acknowledge this explicitly.",
        );
        process.exitCode = 1;
        return;
      }
      if (outcome.plan !== null) {
        process.stdout.write(formatRunPlan(outcome.plan));
      }
    },
  );

program
  .command("create-generation")
  .description("Create one immutable generation snapshot")
  .requiredOption(
    "--season <season>",
    "three-digit season alias or four-digit season ID",
  )
  .option("--profile <profile>", "configuration profile under config/profiles/")
  .option("--generation <generation>", "explicit four-digit generation ID")
  .option("--generations-root <path>", "root directory for generations")
  .option(
    "--accept-prompt-only-one-shot",
    "explicitly accept prompt-only one-shot enforcement for command contestants",
  )
  .action(
    async (options: {
      season: string;
      profile?: string;
      generation?: string;
      generationsRoot?: string;
      acceptPromptOnlyOneShot?: boolean;
    }) => {
      const profileId = await requireProfile("create-generation", options.profile);
      const result = await createGeneration({
        repositoryRoot: process.cwd(),
        seasonId: normalizeSeasonId(options.season),
        profileId,
        ...(options.generation === undefined
          ? {}
          : { generationId: normalizeGenerationId(options.generation) }),
        ...(options.generationsRoot === undefined
          ? {}
          : { generationsRoot: resolve(options.generationsRoot) }),
        acceptPromptOnlyOneShot: options.acceptPromptOnlyOneShot === true,
      });
      console.log(
        `[${result.generationId}] generation created: ${result.generationPath}`,
      );
    },
  );

program
  .command("run-generation")
  .description("Run one generation through scoring and the public gallery")
  .option("--season <season>", "create a generation for this season")
  .option("--profile <profile>", "configuration profile when creating a generation")
  .option("--generation <generation>", "existing four-digit generation ID")
  .option("--generation-path <path>", "existing generation directory")
  .option("--generations-root <path>", "root directory for an existing generation")
  .option(
    "--allow-model-calls",
    "explicitly permit this run to make external model calls through command adapters",
  )
  .action(
    async (
      options: GenerationLocationOptions & {
        readonly season?: string;
        readonly profile?: string;
        readonly allowModelCalls?: boolean;
      },
    ) => {
      const seasonId =
        options.season === undefined ? undefined : normalizeSeasonId(options.season);
      const profileId =
        seasonId === undefined
          ? undefined
          : await requireProfile("run-generation", options.profile);
      const generationPath =
        options.generation === undefined && options.generationPath === undefined
          ? undefined
          : existingGenerationPath(options);
      const result = await runGeneration({
        repositoryRoot: process.cwd(),
        ...(seasonId === undefined ? {} : { seasonId }),
        ...(profileId === undefined ? {} : { profileId }),
        ...(generationPath === undefined ? {} : { generationPath }),
        ...(options.generationsRoot === undefined
          ? {}
          : { generationsRoot: resolve(options.generationsRoot) }),
        allowModelCalls: options.allowModelCalls === true,
        onProgress: progress(),
      });
      console.log(`[${result.generationId}] generation: ${result.generationPath}`);
      console.log(`[${result.generationId}] gallery: ${result.gallery.publicPath}`);
      console.log(`[${result.generationId}] run-summary: ${result.runSummaryPath}`);
    },
  );

program
  .command("resume-generation")
  .description("Resume incomplete generation work without retrying terminal tasks")
  .option("--generation <generation>", "existing four-digit generation ID")
  .option("--generation-path <path>", "existing generation directory")
  .option("--generations-root <path>", "root directory for an existing generation")
  .option(
    "--allow-model-calls",
    "explicitly permit this run to make external model calls through command adapters",
  )
  .action(
    async (
      options: GenerationLocationOptions & { readonly allowModelCalls?: boolean },
    ) => {
      const generationPath = existingGenerationPath(options);
      const result = await runGeneration({
        repositoryRoot: process.cwd(),
        generationPath,
        resumable: true,
        allowModelCalls: options.allowModelCalls === true,
        onProgress: progress(),
      });
      console.log(`[${result.generationId}] generation: ${result.generationPath}`);
      console.log(`[${result.generationId}] gallery: ${result.gallery.publicPath}`);
      console.log(`[${result.generationId}] run-summary: ${result.runSummaryPath}`);
    },
  );

program
  .command("build-gallery")
  .description("Rebuild only the derived public gallery")
  .option("--generation <generation>", "existing four-digit generation ID")
  .option("--generation-path <path>", "existing generation directory")
  .option("--generations-root <path>", "root directory for an existing generation")
  .action(async (options: GenerationLocationOptions) => {
    const generationPath = existingGenerationPath(options);
    const result = await buildGallery({
      repositoryRoot: process.cwd(),
      generationPath,
    });
    console.log(`gallery: ${result.publicPath}`);
  });

program
  .command("summarize-generation")
  .description(
    "Regenerate the private run-summary.json from copied artifacts (no model calls)",
  )
  .option("--generation <generation>", "existing four-digit generation ID")
  .option("--generation-path <path>", "existing generation directory")
  .option("--generations-root <path>", "root directory for an existing generation")
  .action(async (options: GenerationLocationOptions) => {
    let generationPath: string;
    try {
      generationPath = existingGenerationPath(options);
    } catch (error) {
      console.error(`summarize-generation failed: ${boundedErrorMessage(error)}`);
      process.exitCode = 1;
      return;
    }
    try {
      const summaryPath = await summarizeGeneration(generationPath);
      console.log(`run-summary: ${summaryPath}`);
    } catch (error) {
      console.error(`summarize-generation failed: ${boundedErrorMessage(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("serve-gallery")
  .description("Serve a completed gallery on loopback until interrupted")
  .option("--generation <generation>", "existing four-digit generation ID")
  .option("--generation-path <path>", "existing generation directory")
  .option("--generations-root <path>", "root directory for an existing generation")
  .action(async (options: GenerationLocationOptions) => {
    const generationPath = existingGenerationPath(options);
    const server = await startLoopbackStaticServer({
      rootPath: join(generationPath, "public"),
      entryFile: "index.html",
    });
    console.log(`gallery: ${server.origin}/`);
    await new Promise<void>((resolvePromise) => {
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        void server.close().finally(resolvePromise);
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
  });

program
  .command("fixture-tournament")
  .description("Create and complete the deterministic offline fixture tournament")
  .option(
    "--output-root <path>",
    "explicit output root; defaults to a collision-safe temporary directory",
  )
  .action(async (options: { readonly outputRoot?: string }) => {
    const outputRoot =
      options.outputRoot === undefined
        ? await mkdtemp(join(tmpdir(), "local-maxima-fixture-"))
        : resolve(options.outputRoot);
    const generationsRoot = join(outputRoot, "generations");
    const created = await createGeneration({
      repositoryRoot: process.cwd(),
      generationsRoot,
      seasonId: "0001",
      profileId: FIXTURE_PROFILE_ID,
    });
    const result = await runGeneration({
      repositoryRoot: process.cwd(),
      generationPath: created.generationPath,
      resumable: true,
      onProgress: progress(),
    });
    console.log(`generation: ${result.generationPath}`);
    console.log(`gallery: ${result.gallery.publicPath}`);
    console.log(`run-summary: ${result.runSummaryPath}`);
  });

program
  .command("run-wave-b")
  .description("Run contestants, validation, rendering, anonymous judging, and awards")
  .option("--season <season>", "three-digit season alias or four-digit season ID")
  .option("--profile <profile>", "configuration profile when creating a generation")
  .option("--generation <generation>", "accept an existing four-digit generation ID")
  .option("--generation-path <path>", "accept an existing generation directory")
  .option("--generations-root <path>", "root directory for newly created generations")
  .option(
    "--allow-model-calls",
    "explicitly permit this run to make external model calls through command adapters",
  )
  .option(
    "--accept-prompt-only-one-shot",
    "explicitly accept prompt-only one-shot enforcement when creating a generation",
  )
  .action(
    async (options: {
      season?: string;
      profile?: string;
      generation?: string;
      generationPath?: string;
      generationsRoot?: string;
      allowModelCalls?: boolean;
      acceptPromptOnlyOneShot?: boolean;
    }) => {
      const seasonId =
        options.season === undefined ? undefined : normalizeSeasonId(options.season);
      const profileId =
        seasonId === undefined
          ? undefined
          : await requireProfile("run-wave-b", options.profile);
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
        ...(profileId === undefined ? {} : { profileId }),
        ...(existingGenerationPath === undefined
          ? {}
          : { generationPath: existingGenerationPath }),
        ...(options.generationsRoot === undefined
          ? {}
          : { generationsRoot: resolve(options.generationsRoot) }),
        ...(generationId === undefined ? {} : { generationId }),
        allowModelCalls: options.allowModelCalls === true,
        acceptPromptOnlyOneShot: options.acceptPromptOnlyOneShot === true,
        onProgress: (message) => console.log(message),
      });
      console.log(`[${result.generationId}] Wave-B complete: ${result.generationPath}`);
    },
  );

await program.parseAsync(process.argv);
