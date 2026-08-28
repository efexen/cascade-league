import { join, resolve } from "node:path";

import { buildGallery, type BuiltGallery } from "../gallery/index.js";
import {
  aggregateGenerationArtifacts,
  writeGenerationLeaderboard,
} from "../scoring/generation.js";
import {
  ManifestSchema,
  LeaderboardSchema,
  UtcTimestampSchema,
  readJsonWithSchema,
  type Leaderboard,
  type Manifest,
} from "../schemas/index.js";
import { writeTextAtomically } from "../contestants/support.js";
import { runWaveB, type WaveBRunOptions } from "./wave-b.js";

export interface GenerationRunOptions extends WaveBRunOptions {
  readonly generatedAt?: string;
}

export interface GenerationRunResult {
  readonly generationPath: string;
  readonly generationId: string;
  readonly leaderboard: Leaderboard;
  readonly gallery: BuiltGallery;
}

function operationTimestamp(options: GenerationRunOptions, manifest: Manifest): string {
  const candidate =
    options.generatedAt ??
    options.now ??
    manifest.completedAt ??
    new Date().toISOString();
  return UtcTimestampSchema.parse(
    candidate instanceof Date ? candidate.toISOString() : candidate,
  );
}

async function updateManifest(
  generationPath: string,
  update: Partial<Manifest>,
): Promise<Manifest> {
  const manifestPath = join(generationPath, "manifest.json");
  const current = await readJsonWithSchema(manifestPath, ManifestSchema);
  const next = ManifestSchema.parse({ ...current, ...update });
  await writeTextAtomically(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

async function loadManifest(generationPath: string): Promise<Manifest> {
  return readJsonWithSchema(join(generationPath, "manifest.json"), ManifestSchema);
}

export async function runGeneration(
  options: GenerationRunOptions,
): Promise<GenerationRunResult> {
  let generationPath =
    options.generationPath === undefined ? undefined : resolve(options.generationPath);
  let manifest: Manifest;
  let waveAlreadyRun = false;
  if (generationPath === undefined) {
    const wave = await runWaveB({ ...options, resumable: true });
    generationPath = wave.generationPath;
    manifest = await loadManifest(generationPath);
    waveAlreadyRun = true;
  } else {
    manifest = await loadManifest(generationPath);
  }
  if (manifest.status === "completed") {
    throw new Error("completed generations are immutable");
  }

  const waveOptions: WaveBRunOptions = {
    ...options,
    generationPath,
    resumable: true,
  };
  if (
    !waveAlreadyRun &&
    manifest.status !== "scored" &&
    manifest.status !== "gallery_complete"
  ) {
    const wave = await runWaveB(waveOptions);
    manifest = await loadManifest(wave.generationPath);
  }

  const generatedAt = operationTimestamp(options, manifest);
  let leaderboard: Leaderboard;
  if (manifest.status === "scored" || manifest.status === "gallery_complete") {
    try {
      leaderboard = await readJsonWithSchema(
        join(generationPath, "leaderboard.json"),
        LeaderboardSchema,
      );
    } catch {
      leaderboard = await aggregateGenerationArtifacts({
        generationPath,
        generatedAt,
      });
      await writeGenerationLeaderboard(generationPath, leaderboard);
    }
  } else {
    leaderboard = await aggregateGenerationArtifacts({
      generationPath,
      generatedAt,
    });
    await writeGenerationLeaderboard(generationPath, leaderboard);
    manifest = await updateManifest(generationPath, { status: "scored" });
  }

  const gallery = await buildGallery({
    repositoryRoot: options.repositoryRoot,
    generationPath,
    leaderboard,
  });
  manifest = await updateManifest(generationPath, { status: "gallery_complete" });
  await updateManifest(generationPath, {
    status: "completed",
    completedAt: operationTimestamp(options, manifest),
  });
  return {
    generationPath,
    generationId: manifest.generationId,
    leaderboard,
    gallery,
  };
}
