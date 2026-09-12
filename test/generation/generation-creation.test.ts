import { createHash } from "node:crypto";
import {
  cp,
  copyFile,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  AnonymousMapSchema,
  ContestantsConfigSchema,
  IdentitySchema,
  LeaderboardSchema,
  ManifestSchema,
  RunPlanSchema,
  RunSchema,
  SnapshotSchema,
  readYamlWithSchema,
} from "../../src/schemas/index.js";
import { createGeneration } from "../../src/artifacts/generation.js";
import { runGeneration } from "../../src/orchestration/generation.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const timestamp = "2026-08-27T20:00:00.000Z";

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function filesUnder(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(join(directory, entry.name), relative)));
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}

const fixtureContestantIds = [
  "fixture-editorial",
  "fixture-geometric",
  "fixture-generic",
] as const;

async function createCompletedFirstGeneration(
  generationsRoot: string,
  complete = true,
  generationRepositoryRoot = repositoryRoot,
  contestantIds: readonly string[] = fixtureContestantIds,
) {
  const first = await createGeneration({
    repositoryRoot: generationRepositoryRoot,
    generationsRoot,
    seasonId: "0001",
    profileId: "fixture",
    generationId: "0001",
    now: timestamp,
  });
  const manifest = ManifestSchema.parse(
    JSON.parse(
      await readFile(join(first.generationPath, "manifest.json"), "utf8"),
    ) as unknown,
  );
  if (complete) {
    await writeFile(
      join(first.generationPath, "manifest.json"),
      `${JSON.stringify(
        {
          ...manifest,
          status: "completed",
          completedAt: "2026-08-27T20:10:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  const entries = await Promise.all(
    contestantIds.map(async (contestantId, index) => {
      const screenshotPath = `contestants/${contestantId}/screenshot.png`;
      const seedScreenshot = await readFile(
        join(first.generationPath, "challenge/thumbnails/seed-01.png"),
      );
      await writeFile(join(first.generationPath, screenshotPath), seedScreenshot);
      return {
        rank: index + 1,
        contestantId,
        displayName: `Contestant ${index + 1}`,
        harnessName: "Fixture Harness",
        modelName: `Model ${index + 1}`,
        status: "valid" as const,
        screenshotPath,
        combinedScore: 80 - index,
        medianScore: 80 - index,
        originalityScore: 15 - index,
        completedJudgeCount: 1,
        expectedJudgeCount: 1,
        judgeScores: [
          {
            judgeId: "fixture-critic-a",
            totalScore: 80 - index,
            originalityScore: 15 - index,
            critique: "A durable fixture score.",
          },
        ],
        awards: [],
        failure: null,
      };
    }),
  );
  const leaderboard = LeaderboardSchema.parse({
    schemaVersion: 1,
    seasonId: "0001",
    generationId: "0001",
    generatedAt: timestamp,
    rankingMethod: "mean-valid-judge-score-v1",
    expectedJudgeCount: 1,
    entries,
  });
  await writeFile(
    join(first.generationPath, "leaderboard.json"),
    `${JSON.stringify(leaderboard, null, 2)}\n`,
    "utf8",
  );
  return { first, entries };
}

async function copyRepositoryForTest(): Promise<string> {
  const parent = await createTestTempRoot("local-maxima-repository-");
  const copy = join(parent, "repository");
  await cp(repositoryRoot, copy, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${join("", "node_modules")}/`) &&
      !source.endsWith(`${join("", "node_modules")}`),
  });
  return copy;
}

function tableMarkup(html: string): string {
  const start = html.indexOf('<table class="judge-matrix">');
  const end = html.indexOf("</table>", start);
  if (start < 0 || end < 0) throw new Error("judge matrix table is missing");
  return html.slice(start, end + "</table>".length);
}

describe("immutable generation creation", () => {
  it("uses the previous generation actual judge matrix and hashes every presentation input", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-generations-presentation-",
    );
    const first = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    const completed = await runGeneration({
      repositoryRoot,
      generationPath: first.generationPath,
      generatedAt: "2026-08-27T20:15:00.000Z",
    });
    const second = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0002",
      now: "2026-08-28T20:00:00.000Z",
    });

    const firstPublicHtml = await readFile(
      join(completed.gallery.publicPath, "index.html"),
      "utf8",
    );
    const secondChallengeHtml = await readFile(
      join(second.generationPath, "challenge/challenge.html"),
      "utf8",
    );
    expect(tableMarkup(secondChallengeHtml)).toBe(tableMarkup(firstPublicHtml));

    const firstManifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(join(first.generationPath, "manifest.json"), "utf8"),
      ) as unknown,
    );
    for (const contestantId of firstManifest.contestantIds) {
      const run = RunSchema.parse(
        JSON.parse(
          await readFile(
            join(first.generationPath, `contestants/${contestantId}/run.json`),
            "utf8",
          ),
        ) as unknown,
      );
      expect(secondChallengeHtml).toContain(
        run.durationMs === null
          ? "Runtime</dt><dd>—"
          : `Runtime</dt><dd>${(run.durationMs / 1000).toFixed(2)} s`,
      );
      expect(secondChallengeHtml).toContain(
        run.usage.estimatedCostUsd === null
          ? "Estimated cost</dt><dd>—"
          : `Estimated cost</dt><dd>USD ${run.usage.estimatedCostUsd.toFixed(6)}`,
      );
    }

    const secondSnapshot = SnapshotSchema.parse(
      JSON.parse(
        await readFile(join(second.generationPath, "challenge/snapshot.json"), "utf8"),
      ) as unknown,
    );
    const expectedPrivatePaths = [
      "config/judges.yaml",
      "judging/anonymous-map.json",
      ...firstManifest.contestantIds.map(
        (contestantId) => `contestants/${contestantId}/run.json`,
      ),
    ];
    const firstMap = AnonymousMapSchema.parse(
      JSON.parse(
        await readFile(
          join(first.generationPath, "judging/anonymous-map.json"),
          "utf8",
        ),
      ) as unknown,
    );
    for (const judgeId of firstManifest.judgeIds) {
      for (const entry of firstMap.entries) {
        expectedPrivatePaths.push(
          `judging/${judgeId}/tasks/${entry.anonymousCandidateId}.json`,
        );
      }
    }
    for (const relativePath of expectedPrivatePaths) {
      expect(secondSnapshot.inputHashes[`generations/0001/${relativePath}`]).toBe(
        await sha256(join(first.generationPath, relativePath)),
      );
    }

    expect(
      await sharp(
        join(
          second.generationPath,
          "challenge/thumbnails/previous-fixture-editorial.png",
        ),
      ).metadata(),
    ).toMatchObject({ width: 360, height: 300 });
  }, 30000);

  it("writes config/profile.json, hashes it, and copies profile sources verbatim", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const result = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      profileId: "fixture",
      now: timestamp,
    });
    const profileJsonPath = join(result.generationPath, "config/profile.json");
    const profileJson = JSON.parse(await readFile(profileJsonPath, "utf8")) as unknown;
    expect(profileJson).toEqual({
      schemaVersion: 1,
      profileId: "fixture",
      sourcePaths: {
        contestants: "config/profiles/fixture/contestants.yaml",
        judges: "config/profiles/fixture/judges.yaml",
      },
    });

    const snapshot = SnapshotSchema.parse(
      JSON.parse(
        await readFile(join(result.generationPath, "challenge/snapshot.json"), "utf8"),
      ) as unknown,
    );
    expect(snapshot).toHaveProperty(
      "publicationSourceNonce",
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    );
    expect(
      (await stat(join(result.generationPath, "judging/anonymous-map.json"))).mode &
        0o077,
    ).toBe(0);
    expect(snapshot.inputHashes["config/profile.json"]).toBe(
      await sha256(profileJsonPath),
    );
    expect(snapshot.inputHashes["config/profiles/fixture/contestants.yaml"]).toBe(
      await sha256(join(repositoryRoot, "config/profiles/fixture/contestants.yaml")),
    );
    expect(snapshot.inputHashes["config/profiles/fixture/judges.yaml"]).toBe(
      await sha256(join(repositoryRoot, "config/profiles/fixture/judges.yaml")),
    );

    expect(
      await readFile(join(result.generationPath, "config/contestants.yaml"), "utf8"),
    ).toBe(
      await readFile(
        join(repositoryRoot, "config/profiles/fixture/contestants.yaml"),
        "utf8",
      ),
    );
    expect(
      await readFile(join(result.generationPath, "config/judges.yaml"), "utf8"),
    ).toBe(
      await readFile(
        join(repositoryRoot, "config/profiles/fixture/judges.yaml"),
        "utf8",
      ),
    );

    // A generation-level reader must accept the copied configuration through
    // the tolerant schema, proving the rebuild-from-copied-config rule.
    const copied = await readYamlWithSchema(
      join(result.generationPath, "config/contestants.yaml"),
      ContestantsConfigSchema,
    );
    expect(copied.contestants.map((entry) => entry.id)).toEqual([
      "fixture-editorial",
      "fixture-geometric",
      "fixture-generic",
    ]);
  });

  it("writes run-plan.json, validates it, and hashes it into the snapshot", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const result = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      profileId: "fixture",
      now: timestamp,
    });
    const runPlanPath = join(result.generationPath, "run-plan.json");
    const runPlanText = await readFile(runPlanPath, "utf8");
    const plan = RunPlanSchema.parse(JSON.parse(runPlanText) as unknown);
    expect(plan.schemaVersion).toBe(1);
    expect(plan.seasonId).toBe("0001");
    expect(plan.generationId).toBe("0001");
    expect(plan.previousGenerationId).toBeNull();
    expect(plan.profileId).toBe("fixture");
    expect(plan.externalModelCallsRequired).toBe(false);
    expect(plan.callCounts.maximumTotalCalls).toBe(11);
    expect(plan.promptOnlyOneShot).toEqual([]);
    expect(plan.promptOnlyOneShotAccepted).toBe(false);

    expect(plan.configSnapshotHashes).toEqual({
      "config/contestants.yaml": await sha256(
        join(result.generationPath, "config/contestants.yaml"),
      ),
      "config/judges.yaml": await sha256(
        join(result.generationPath, "config/judges.yaml"),
      ),
      "config/profile.json": await sha256(
        join(result.generationPath, "config/profile.json"),
      ),
    });

    const snapshot = SnapshotSchema.parse(
      JSON.parse(
        await readFile(join(result.generationPath, "challenge/snapshot.json"), "utf8"),
      ) as unknown,
    );
    expect(snapshot.inputHashes["run-plan.json"]).toBe(
      createHash("sha256").update(runPlanText).digest("hex"),
    );

    // The plan is private: it never appears in public gallery output.
    expect(runPlanPath).toContain(result.generationPath);
    expect(
      await filesUnder(join(result.generationPath, "public")).catch(() => []),
    ).toEqual([]);
  });

  it("initializes pending run.json observed versions as unknown, never the configured identity", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const result = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      profileId: "fixture",
      now: timestamp,
    });
    for (const contestantId of fixtureContestantIds) {
      const run = RunSchema.parse(
        JSON.parse(
          await readFile(
            join(result.generationPath, "contestants", contestantId, "run.json"),
            "utf8",
          ),
        ) as unknown,
      );
      // Nothing has executed yet, so the *observed* identity is explicitly
      // unknown. It must never be pre-filled from the configured identity.
      expect(run.status).toBe("pending");
      expect(run.observedVersions).toEqual({ harness: null, model: null });
      // The configured versions remain only in the immutable identity.json.
      const identityText = await readFile(
        join(result.generationPath, "contestants", contestantId, "identity.json"),
        "utf8",
      );
      const identity = IdentitySchema.parse(JSON.parse(identityText) as unknown);
      expect(identity.harness.configuredVersion).toBe("1.0.0");
      expect(identity.model.configuredVersion).toBe("1.0.0");
      expect(identityText).not.toContain("observedVersions");
    }
  });

  it("rejects unknown, symlinked, or traversal profile identifiers at creation", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    await expect(
      createGeneration({
        repositoryRoot,
        generationsRoot,
        seasonId: "0001",
        generationId: "0001",
        profileId: "absent",
        now: timestamp,
      }),
    ).rejects.toThrow(/absent/);
    await expect(
      createGeneration({
        repositoryRoot,
        generationsRoot,
        seasonId: "0001",
        generationId: "0001",
        profileId: "../x",
        now: timestamp,
      }),
    ).rejects.toThrow(/slug|profile identifier/i);
    expect(await readdir(generationsRoot)).toEqual([]);
  });

  it("creates validated artifacts with identical contestant snapshots", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const result = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      profileId: "fixture",
      now: timestamp,
    });
    const generationPath = result.generationPath;

    const manifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(join(generationPath, "manifest.json"), "utf8"),
      ) as unknown,
    );
    const snapshot = SnapshotSchema.parse(
      JSON.parse(
        await readFile(join(generationPath, "challenge/snapshot.json"), "utf8"),
      ) as unknown,
    );
    const anonymousMap = AnonymousMapSchema.parse(
      JSON.parse(
        await readFile(join(generationPath, "judging/anonymous-map.json"), "utf8"),
      ) as unknown,
    );

    expect(manifest.status).toBe("created");
    expect(manifest.createdAt).toBe(timestamp);
    expect(manifest.environment.playwrightVersion).toBe("1.63.0");
    expect(manifest.environment.chromiumVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(manifest.contestantIds).toHaveLength(3);
    expect(
      new Set(anonymousMap.entries.map((entry) => entry.anonymousCandidateId)).size,
    ).toBe(3);
    expect(
      anonymousMap.entries.every((entry) =>
        /^candidate-[a-z0-9]{4,32}$/.test(entry.anonymousCandidateId),
      ),
    ).toBe(true);
    expect(snapshot.resolvedHtmlSha256).toBe(
      await sha256(join(generationPath, "challenge/challenge.html")),
    );
    expect((await stat(join(generationPath, "challenge"))).mode & 0o222).toBe(0);
    expect(
      (await stat(join(generationPath, "challenge/challenge.html"))).mode & 0o222,
    ).toBe(0);
    expect(
      (await stat(join(generationPath, "judging/anonymous-map.json"))).mode & 0o077,
    ).toBe(0);
    expect((await stat(generationPath)).mode & 0o077).toBe(0);

    const canonicalFiles = await filesUnder(join(generationPath, "challenge"), "");
    const canonicalHashes = new Map(
      await Promise.all(
        canonicalFiles
          .filter(
            (file) =>
              file !== "snapshot.json" &&
              file !== "fallback.css" &&
              file !== "source-archive.json",
          )
          .map(
            async (file) =>
              [file, await sha256(join(generationPath, "challenge", file))] as const,
          ),
      ),
    );
    for (const contestantId of manifest.contestantIds) {
      const workspacePath = join(
        generationPath,
        "contestants",
        contestantId,
        "workspace",
      );
      expect(await filesUnder(workspacePath)).toEqual(
        [...canonicalHashes.keys()].sort(),
      );
      for (const [file, expectedHash] of canonicalHashes) {
        expect(await sha256(join(workspacePath, file))).toBe(expectedHash);
      }
      expect((await stat(workspacePath)).mode & 0o222).not.toBe(0);
      expect((await stat(join(workspacePath, "challenge.html"))).mode & 0o222).toBe(0);
      expect(await readFile(join(workspacePath, "challenge.html"), "utf8")).toContain(
        'href="submission.css"',
      );
    }

    expect(await readFile(join(generationPath, "config/challenge.yaml"), "utf8")).toBe(
      await readFile(
        join(repositoryRoot, "challenge/season-001/challenge.yaml"),
        "utf8",
      ),
    );
  });

  it("refuses to reuse a generation number without changing existing bytes", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const options = {
      repositoryRoot,
      generationsRoot,
      seasonId: "0001" as const,
      profileId: "fixture",
      generationId: "0001" as const,
      now: timestamp,
    };
    const result = await createGeneration(options);
    const manifestBefore = await readFile(join(result.generationPath, "manifest.json"));
    await expect(createGeneration(options)).rejects.toThrow(/exist|reuse|duplicate/i);
    expect(await readFile(join(result.generationPath, "manifest.json"))).toEqual(
      manifestBefore,
    );
  });

  it("records hashes for representative repository snapshot inputs", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const result = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    const snapshot = SnapshotSchema.parse(
      JSON.parse(
        await readFile(join(result.generationPath, "challenge/snapshot.json"), "utf8"),
      ) as unknown,
    );
    const representatives = [
      "challenge/season-001/challenge.hbs",
      "challenge/season-001/starter.css",
      "challenge/season-001/fallback.css",
      "challenge/season-001/seed/seed-generation.json",
      "challenge/season-001/fonts/lm-mono.ttf",
      "challenge/season-001/fonts/OFL-1.1.txt",
      "challenge/season-001/seed/thumbnails/seed-01.png",
      "challenge/season-001/challenge.yaml",
      "config/profiles/fixture/contestants.yaml",
      "config/profiles/fixture/judges.yaml",
    ];
    for (const provenancePath of representatives) {
      expect(snapshot.inputHashes[provenancePath]).toBe(
        await sha256(join(repositoryRoot, provenancePath)),
      );
    }
    expect(snapshot.assetHashes["challenge.html"]).toBe(snapshot.resolvedHtmlSha256);
    expect(snapshot.assetHashes).not.toHaveProperty("snapshot.json");
  });

  it("changes provenance hashes when representative source inputs change", async () => {
    const originalRepositoryRoot = await copyRepositoryForTest();
    const changedRepositoryRoot = await copyRepositoryForTest();
    const changedSources = [
      "challenge/season-001/challenge.hbs",
      "challenge/season-001/seed/seed-generation.json",
      "challenge/season-001/challenge.yaml",
      "config/profiles/fixture/contestants.yaml",
      "config/profiles/fixture/judges.yaml",
    ];
    for (const sourcePath of changedSources) {
      const absolutePath = join(changedRepositoryRoot, sourcePath);
      const suffix = sourcePath.endsWith(".json")
        ? "\n"
        : sourcePath.endsWith(".hbs")
          ? "\n<!-- provenance change -->\n"
          : "\n# provenance change\n";
      await writeFile(
        absolutePath,
        `${await readFile(absolutePath, "utf8")}${suffix}`,
        "utf8",
      );
    }
    const fontPath = join(
      changedRepositoryRoot,
      "challenge/season-001/fonts/lm-mono.ttf",
    );
    await writeFile(
      fontPath,
      Buffer.concat([await readFile(fontPath), Buffer.from([0])]),
    );
    const thumbnailPath = join(
      changedRepositoryRoot,
      "challenge/season-001/seed/thumbnails/seed-01.png",
    );
    await writeFile(
      thumbnailPath,
      await sharp({
        create: {
          width: 1280,
          height: 1200,
          channels: 4,
          background: { r: 30, g: 30, b: 30, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );

    const originalGenerationsRoot = await createTestTempRoot(
      "local-maxima-generations-",
    );
    const changedGenerationsRoot = await createTestTempRoot(
      "local-maxima-generations-",
    );
    const originalGeneration = await createGeneration({
      repositoryRoot: originalRepositoryRoot,
      generationsRoot: originalGenerationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    const changedGeneration = await createGeneration({
      repositoryRoot: changedRepositoryRoot,
      generationsRoot: changedGenerationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    const originalSnapshot = SnapshotSchema.parse(
      JSON.parse(
        await readFile(
          join(originalGeneration.generationPath, "challenge/snapshot.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const changedSnapshot = SnapshotSchema.parse(
      JSON.parse(
        await readFile(
          join(changedGeneration.generationPath, "challenge/snapshot.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const changedPaths = [
      ...changedSources,
      "challenge/season-001/fonts/lm-mono.ttf",
      "challenge/season-001/seed/thumbnails/seed-01.png",
    ];
    for (const sourcePath of changedPaths) {
      expect(changedSnapshot.inputHashes[sourcePath]).not.toBe(
        originalSnapshot.inputHashes[sourcePath],
      );
    }
  });

  it("uses a completed previous leaderboard as the next challenge data source", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    await createCompletedFirstGeneration(generationsRoot);

    const second = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0002",
      now: "2026-08-28T20:00:00.000Z",
    });
    const snapshot = SnapshotSchema.parse(
      JSON.parse(
        await readFile(join(second.generationPath, "challenge/snapshot.json"), "utf8"),
      ) as unknown,
    );
    const manifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(join(second.generationPath, "manifest.json"), "utf8"),
      ) as unknown,
    );
    expect(snapshot.dataSource).toEqual({
      kind: "previous_generation",
      generationId: "0001",
      path: "generations/0001/leaderboard.json",
    });
    expect(manifest.previousGenerationId).toBe("0001");
    expect(
      await readFile(join(second.generationPath, "challenge/challenge.html"), "utf8"),
    ).toContain("Contestant 1");
    expect(
      await stat(
        join(
          second.generationPath,
          "challenge/thumbnails/previous-fixture-editorial.png",
        ),
      ),
    ).toBeTruthy();
  });

  it("records hashes for the previous manifest, leaderboard, and used screenshots", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const { first, entries } = await createCompletedFirstGeneration(generationsRoot);
    const second = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0002",
      now: "2026-08-28T20:00:00.000Z",
    });
    const snapshot = SnapshotSchema.parse(
      JSON.parse(
        await readFile(join(second.generationPath, "challenge/snapshot.json"), "utf8"),
      ) as unknown,
    );

    expect(snapshot.inputHashes["generations/0001/manifest.json"]).toBe(
      await sha256(join(first.generationPath, "manifest.json")),
    );
    expect(snapshot.inputHashes["generations/0001/leaderboard.json"]).toBe(
      await sha256(join(first.generationPath, "leaderboard.json")),
    );
    for (const entry of entries) {
      expect(snapshot.inputHashes[`generations/0001/${entry.screenshotPath}`]).toBe(
        await sha256(join(first.generationPath, entry.screenshotPath)),
      );
    }
  });

  it("copies prior candidate screenshots only as fixed-size reduced thumbnails", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const { first, entries } = await createCompletedFirstGeneration(generationsRoot);
    const contestantIds = [...fixtureContestantIds];
    const originalScreenshot = await sharp({
      create: {
        width: 1440,
        height: 1200,
        channels: 4,
        background: { r: 13, g: 27, b: 42, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    await Promise.all(
      contestantIds.map((contestantId) =>
        writeFile(
          join(first.generationPath, `contestants/${contestantId}/screenshot.png`),
          originalScreenshot,
        ),
      ),
    );

    const second = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0002",
      now: "2026-08-28T20:00:00.000Z",
    });
    const originalHash = await sha256(
      join(first.generationPath, entries[0]!.screenshotPath),
    );
    const expectedThumbnailPaths = entries.flatMap((entry) => [
      join(
        second.generationPath,
        "challenge",
        `thumbnails/previous-${entry.contestantId}.png`,
      ),
      ...contestantIds.map((contestantId) =>
        join(
          second.generationPath,
          "contestants",
          contestantId,
          "workspace",
          `thumbnails/previous-${entry.contestantId}.png`,
        ),
      ),
    ]);

    for (const thumbnailPath of expectedThumbnailPaths) {
      const metadata = await sharp(thumbnailPath).metadata();
      expect(metadata.width).toBe(360);
      expect(metadata.height).toBe(300);
      expect(await sha256(thumbnailPath)).not.toBe(originalHash);
    }

    const generationPngHashes = await Promise.all(
      (await filesUnder(second.generationPath))
        .filter((file) => file.endsWith(".png"))
        .map((file) => sha256(join(second.generationPath, file))),
    );
    expect(generationPngHashes).not.toContain(originalHash);
  });

  it("rejects a correctly named previous screenshot that is not a PNG", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const first = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
      generationId: "0001",
      now: timestamp,
    });
    const manifest = JSON.parse(
      await readFile(join(first.generationPath, "manifest.json"), "utf8"),
    ) as { status: string; completedAt: string | null };
    manifest.status = "completed";
    manifest.completedAt = "2026-08-27T20:10:00.000Z";
    await writeFile(
      join(first.generationPath, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const contestantIds = ["fixture-editorial", "fixture-geometric", "fixture-generic"];
    const jpeg = await sharp({
      create: {
        width: 1440,
        height: 1200,
        channels: 3,
        background: "#132b42",
      },
    })
      .jpeg()
      .toBuffer();
    const entries = await Promise.all(
      contestantIds.map(async (contestantId, index) => {
        const screenshotPath = `contestants/${contestantId}/screenshot.png`;
        await writeFile(join(first.generationPath, screenshotPath), jpeg);
        return {
          rank: index + 1,
          contestantId,
          displayName: `Contestant ${index + 1}`,
          harnessName: "Fixture Harness",
          modelName: `Model ${index + 1}`,
          status: "valid" as const,
          screenshotPath,
          combinedScore: 80 - index,
          medianScore: 80 - index,
          originalityScore: 15 - index,
          completedJudgeCount: 1,
          expectedJudgeCount: 1,
          judgeScores: [
            {
              judgeId: "fixture-critic-a",
              totalScore: 80 - index,
              originalityScore: 15 - index,
              critique: "A durable fixture score.",
            },
          ],
          awards: [],
          failure: null,
        };
      }),
    );
    await writeFile(
      join(first.generationPath, "leaderboard.json"),
      `${JSON.stringify(
        LeaderboardSchema.parse({
          schemaVersion: 1,
          seasonId: "0001",
          generationId: "0001",
          generatedAt: timestamp,
          rankingMethod: "mean-valid-judge-score-v1",
          expectedJudgeCount: 1,
          entries,
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      createGeneration({
        repositoryRoot,
        generationsRoot,
        seasonId: "0001",
        profileId: "fixture",
        generationId: "0002",
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).rejects.toThrow(/png|image/i);
    expect(await readdir(generationsRoot)).toEqual(["0001"]);
  });

  it("rejects a previous screenshot symlink that escapes the generation", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const { first } = await createCompletedFirstGeneration(generationsRoot);
    const outsideDirectory = await createTestTempRoot("local-maxima-outside-");
    const outsideScreenshot = join(outsideDirectory, "screenshot.png");
    await copyFile(
      join(first.generationPath, "challenge/thumbnails/seed-02.png"),
      outsideScreenshot,
    );
    const escapedScreenshot = join(
      first.generationPath,
      "contestants/fixture-editorial/screenshot.png",
    );
    await unlink(escapedScreenshot);
    await symlink(outsideScreenshot, escapedScreenshot);

    await expect(
      createGeneration({
        repositoryRoot,
        generationsRoot,
        seasonId: "0001",
        profileId: "fixture",
        generationId: "0002",
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).rejects.toThrow(/symlink|contained/i);
    expect(await readdir(generationsRoot)).toEqual(["0001"]);
  });

  it("rejects generation two when the previous manifest is incomplete", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    await createCompletedFirstGeneration(generationsRoot, false);

    await expect(
      createGeneration({
        repositoryRoot,
        generationsRoot,
        seasonId: "0001",
        profileId: "fixture",
        generationId: "0002",
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).rejects.toThrow(/completed|incomplete/i);
    expect(await readdir(generationsRoot)).toEqual(["0001"]);
  });

  it("rejects generation two when the previous copied judges config fails its manifest hash", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const { first } = await createCompletedFirstGeneration(generationsRoot);
    const previousJudgesPath = join(first.generationPath, "config/judges.yaml");
    await writeFile(
      previousJudgesPath,
      `${await readFile(previousJudgesPath, "utf8")}\n# tampered after completion\n`,
      "utf8",
    );

    await expect(
      createGeneration({
        repositoryRoot,
        generationsRoot,
        seasonId: "0001",
        profileId: "fixture",
        generationId: "0002",
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).rejects.toThrow(/config\/judges\.yaml failed its manifest hash check/u);
    expect(await readdir(generationsRoot)).toEqual(["0001"]);
  });

  it("rejects a changed current enabled roster without creating generation two", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const copiedRepositoryRoot = await copyRepositoryForTest();
    await createCompletedFirstGeneration(generationsRoot, true, copiedRepositoryRoot);
    const contestantsConfigPath = join(
      copiedRepositoryRoot,
      "config/profiles/fixture/contestants.yaml",
    );
    const contestantsConfig = await readFile(contestantsConfigPath, "utf8");
    await writeFile(
      contestantsConfigPath,
      contestantsConfig.replaceAll("fixture-generic", "fixture-replacement"),
      "utf8",
    );

    await expect(
      createGeneration({
        repositoryRoot: copiedRepositoryRoot,
        generationsRoot,
        seasonId: "0001",
        profileId: "fixture",
        generationId: "0002",
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).rejects.toThrow(/roster|match/i);
    expect(await readdir(generationsRoot)).toEqual(["0001"]);
  });

  it("requires at least two enabled contestants at generation creation", async () => {
    const copiedRepositoryRoot = await copyRepositoryForTest();
    const contestantsConfigPath = join(
      copiedRepositoryRoot,
      "config/profiles/fixture/contestants.yaml",
    );
    const contestantsConfig = await readFile(contestantsConfigPath, "utf8");
    await writeFile(
      contestantsConfigPath,
      contestantsConfig
        .replace(/(- id: fixture-geometric[\s\S]*? {4}enabled:) true/u, "$1 false")
        .replace(/(- id: fixture-generic[\s\S]*? {4}enabled:) true/u, "$1 false"),
      "utf8",
    );
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");

    await expect(
      createGeneration({
        repositoryRoot: copiedRepositoryRoot,
        generationsRoot,
        seasonId: "0001",
        profileId: "fixture",
        generationId: "0001",
        now: timestamp,
      }),
    ).rejects.toThrow(/at least two enabled/i);
    await expect(stat(join(generationsRoot, "0001"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a previous leaderboard whose contestant roster differs", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const { first, entries } = await createCompletedFirstGeneration(generationsRoot);
    await writeFile(
      join(first.generationPath, "leaderboard.json"),
      `${JSON.stringify(
        LeaderboardSchema.parse({
          schemaVersion: 1,
          seasonId: "0001",
          generationId: "0001",
          generatedAt: timestamp,
          rankingMethod: "mean-valid-judge-score-v1",
          expectedJudgeCount: 1,
          entries: entries.slice(0, 2),
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      createGeneration({
        repositoryRoot,
        generationsRoot,
        seasonId: "0001",
        profileId: "fixture",
        generationId: "0002",
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).rejects.toThrow(/leaderboard|roster/i);
    expect(await readdir(generationsRoot)).toEqual(["0001"]);
  });

  it("allows only one concurrent creator to win a generation collision", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-generations-");
    const options = {
      repositoryRoot,
      generationsRoot,
      seasonId: "0001" as const,
      profileId: "fixture",
      generationId: "0001" as const,
      now: timestamp,
    };
    const results = await Promise.allSettled([
      createGeneration(options),
      createGeneration(options),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
