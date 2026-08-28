#!/usr/bin/env node

import { Command } from "commander";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createGeneration } from "../artifacts/generation.js";
import { buildGallery } from "../gallery/index.js";
import { runGeneration } from "../orchestration/generation.js";
import { runWaveB } from "../orchestration/wave-b.js";
import { startLoopbackStaticServer } from "../rendering/index.js";
import {
  normalizeGenerationId,
  normalizeSeasonId,
  verifyRepository,
} from "./commands.js";

const program = new Command();

interface GenerationLocationOptions {
  readonly generation?: string;
  readonly generationPath?: string;
  readonly generationsRoot?: string;
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

program.name("garden").description("Local Maxima generation tools").version("0.1.0");

program
  .command("verify")
  .description("Verify the local runtime and repository inputs")
  .action(async () => {
    const report = await verifyRepository(process.cwd());
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
  .command("create-generation")
  .description("Create one immutable generation snapshot")
  .requiredOption(
    "--season <season>",
    "three-digit season alias or four-digit season ID",
  )
  .option("--generation <generation>", "explicit four-digit generation ID")
  .option("--generations-root <path>", "root directory for generations")
  .action(
    async (options: {
      season: string;
      generation?: string;
      generationsRoot?: string;
    }) => {
      const result = await createGeneration({
        repositoryRoot: process.cwd(),
        seasonId: normalizeSeasonId(options.season),
        ...(options.generation === undefined
          ? {}
          : { generationId: normalizeGenerationId(options.generation) }),
        ...(options.generationsRoot === undefined
          ? {}
          : { generationsRoot: resolve(options.generationsRoot) }),
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
  .option("--generation <generation>", "existing four-digit generation ID")
  .option("--generation-path <path>", "existing generation directory")
  .option("--generations-root <path>", "root directory for an existing generation")
  .action(async (options: GenerationLocationOptions & { readonly season?: string }) => {
    const seasonId =
      options.season === undefined ? undefined : normalizeSeasonId(options.season);
    const generationPath =
      options.generation === undefined && options.generationPath === undefined
        ? undefined
        : existingGenerationPath(options);
    const result = await runGeneration({
      repositoryRoot: process.cwd(),
      ...(seasonId === undefined ? {} : { seasonId }),
      ...(generationPath === undefined ? {} : { generationPath }),
      ...(options.generationsRoot === undefined
        ? {}
        : { generationsRoot: resolve(options.generationsRoot) }),
      onProgress: progress(),
    });
    console.log(`[${result.generationId}] generation: ${result.generationPath}`);
    console.log(`[${result.generationId}] gallery: ${result.gallery.publicPath}`);
  });

program
  .command("resume-generation")
  .description("Resume incomplete generation work without retrying terminal tasks")
  .option("--generation <generation>", "existing four-digit generation ID")
  .option("--generation-path <path>", "existing generation directory")
  .option("--generations-root <path>", "root directory for an existing generation")
  .action(async (options: GenerationLocationOptions) => {
    const generationPath = existingGenerationPath(options);
    const result = await runGeneration({
      repositoryRoot: process.cwd(),
      generationPath,
      resumable: true,
      onProgress: progress(),
    });
    console.log(`[${result.generationId}] generation: ${result.generationPath}`);
    console.log(`[${result.generationId}] gallery: ${result.gallery.publicPath}`);
  });

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
    });
    const result = await runGeneration({
      repositoryRoot: process.cwd(),
      generationPath: created.generationPath,
      resumable: true,
      onProgress: progress(),
    });
    console.log(`generation: ${result.generationPath}`);
    console.log(`gallery: ${result.gallery.publicPath}`);
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
