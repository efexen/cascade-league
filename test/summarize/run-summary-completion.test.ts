import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createGeneration } from "../../src/artifacts/generation.js";
import { runGeneration } from "../../src/orchestration/generation.js";
import { ManifestSchema, RunSummarySchema } from "../../src/schemas/index.js";
import {
  RUN_SUMMARY_FILE_NAME,
  buildRunSummary,
  serializeRunSummary,
  writeRunSummary,
} from "../../src/summarize/index.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const CREATED_AT = "2026-08-30T10:00:00.000Z";
const COMPLETED_AT = "2026-08-30T11:00:00.000Z";

/** sha256 of every regular file under `root`, keyed by relative path. */
async function hashTree(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const digest = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      hashes.set(relative(root, path), digest);
    }
  };
  await walk(root);
  return hashes;
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      found.push(relative(root, path));
    }
  };
  await walk(root);
  return found.sort();
}

describe("run-summary normal completion wiring", () => {
  let generationPath = "";
  let completionBytes = "";

  beforeAll(async () => {
    const root = await createTestTempRoot("local-maxima-summary-completion-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot: join(root, "generations"),
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: CREATED_AT,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      now: COMPLETED_AT,
    });
    generationPath = generation.generationPath;
    completionBytes = await readFile(
      join(generationPath, RUN_SUMMARY_FILE_NAME),
      "utf8",
    );
  }, 120000);

  it("normal runGeneration completion writes a schema-valid private summary", async () => {
    const manifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(join(generationPath, "manifest.json"), "utf8"),
      ) as unknown,
    );
    expect(manifest.status).toBe("completed");
    const summary = RunSummarySchema.parse(JSON.parse(completionBytes) as unknown);
    expect(summary.generationId).toBe("0001");
    expect(summary.seasonId).toBe("0001");
    // The summary timestamp comes from the durable manifest completion so a
    // later regeneration is byte-identical without any supplied input.
    expect(summary.generatedAt).toBe(manifest.completedAt);
    expect(summary.wallClock.completedAt).toBe(manifest.completedAt);
    expect(summary.totals.callsWithUnknownUsage).toBe(11);
    // The on-disk bytes are exactly the canonical serialization.
    expect(completionBytes).toBe(serializeRunSummary(summary));
  });

  it("regenerating from durable artifacts alone reproduces byte-identical summary bytes", async () => {
    const rebuilt = serializeRunSummary(await buildRunSummary({ generationPath }));
    expect(rebuilt).toBe(completionBytes);
  });

  it("summary regeneration mutates no other durable artifact and no public bytes", async () => {
    const before = await hashTree(generationPath);
    before.delete(RUN_SUMMARY_FILE_NAME);
    const summaryPath = await writeRunSummary(
      generationPath,
      await buildRunSummary({ generationPath }),
    );
    expect(summaryPath).toBe(join(generationPath, RUN_SUMMARY_FILE_NAME));
    const after = await hashTree(generationPath);
    after.delete(RUN_SUMMARY_FILE_NAME);
    expect([...after.entries()]).toEqual([...before.entries()]);
    expect(await readFile(summaryPath, "utf8")).toBe(completionBytes);
  });

  it("keeps run-summary.json and execution metadata private and out of public/", async () => {
    const publicFiles = await listFiles(join(generationPath, "public"));
    expect(publicFiles.length).toBeGreaterThan(0);
    for (const file of publicFiles) {
      expect(file).not.toContain(RUN_SUMMARY_FILE_NAME);
      expect(file).not.toContain("execution-metadata");
    }
    const publicHtml = await readFile(
      join(generationPath, "public/index.html"),
      "utf8",
    );
    expect(publicHtml).toContain("Runtime");
    expect(publicHtml).toContain("Estimated cost");
    expect(publicHtml).toContain("—");
    expect(publicHtml).not.toContain("partial");
    // The private metadata really exists inside the generation, so the
    // public absence above is a privacy result and not a missing-artifact
    // accident.
    const manifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(join(generationPath, "manifest.json"), "utf8"),
      ) as unknown,
    );
    const privateMetadata: string[] = [];
    for (const contestantId of manifest.contestantIds) {
      privateMetadata.push(`contestants/${contestantId}/execution-metadata.json`);
    }
    for (const judgeId of manifest.judgeIds) {
      privateMetadata.push(`judging/${judgeId}/execution-metadata/awards.json`);
    }
    const allFiles = new Set(await listFiles(generationPath));
    const metadataSentinels: string[] = [];
    for (const path of privateMetadata) {
      expect(allFiles.has(path), path).toBe(true);
      metadataSentinels.push(await readFile(join(generationPath, path), "utf8"));
    }
    // Fixture wrappers record a private provider request ID sentinel.
    expect(metadataSentinels.join("\n")).toContain("fixture-request");
    // No public file carries private summary/metadata vocabulary.
    for (const file of publicFiles) {
      if (!/\.(?:html|json|css)$/u.test(file)) continue;
      const text = await readFile(join(generationPath, "public", file), "utf8");
      for (const forbidden of [
        "fixture-request",
        "providerRequestId",
        "execution-metadata",
        "estimatedCostUsd",
        "inputTokens",
        "run-summary",
      ]) {
        expect(text, `${file} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
