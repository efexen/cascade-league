import { createHash } from "node:crypto";
import {
  cp,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  AnonymousMapSchema,
  LeaderboardSchema,
  ManifestSchema,
  SnapshotSchema,
} from "../../src/schemas/index.js";
import { createGeneration } from "../../src/artifacts/generation.js";

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
        judgeScores: [],
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
  const parent = await mkdtemp(join(tmpdir(), "local-maxima-repository-"));
  const copy = join(parent, "repository");
  await cp(repositoryRoot, copy, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${join("", "node_modules")}/`) &&
      !source.endsWith(`${join("", "node_modules")}`),
  });
  return copy;
}

describe("immutable generation creation", () => {
  it("creates validated artifacts with identical contestant snapshots", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
    const result = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
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
    expect(manifest.environment.playwrightVersion).toBe("1.55.0");
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

    const canonicalFiles = await filesUnder(join(generationPath, "challenge"), "");
    const canonicalHashes = new Map(
      await Promise.all(
        canonicalFiles
          .filter((file) => file !== "snapshot.json" && file !== "fallback.css")
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
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
    const options = {
      repositoryRoot,
      generationsRoot,
      seasonId: "0001" as const,
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
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
    const result = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
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
      "config/contestants.yaml",
      "config/judges.yaml",
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
      "config/contestants.yaml",
      "config/judges.yaml",
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
          width: 1440,
          height: 1200,
          channels: 4,
          background: { r: 30, g: 30, b: 30, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );

    const originalGenerationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-generations-"),
    );
    const changedGenerationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-generations-"),
    );
    const originalGeneration = await createGeneration({
      repositoryRoot: originalRepositoryRoot,
      generationsRoot: originalGenerationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: timestamp,
    });
    const changedGeneration = await createGeneration({
      repositoryRoot: changedRepositoryRoot,
      generationsRoot: changedGenerationsRoot,
      seasonId: "0001",
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
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
    await createCompletedFirstGeneration(generationsRoot);

    const second = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
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
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
    const { first, entries } = await createCompletedFirstGeneration(generationsRoot);
    const second = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
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
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
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
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
    const first = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
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
          judgeScores: [],
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
        generationId: "0002",
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).rejects.toThrow(/png|image/i);
    expect(await readdir(generationsRoot)).toEqual(["0001"]);
  });

  it("rejects a previous screenshot symlink that escapes the generation", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
    const { first } = await createCompletedFirstGeneration(generationsRoot);
    const outsideDirectory = await mkdtemp(join(tmpdir(), "local-maxima-outside-"));
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
        generationId: "0002",
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).rejects.toThrow(/symlink|contained/i);
    expect(await readdir(generationsRoot)).toEqual(["0001"]);
  });

  it("rejects generation two when the previous manifest is incomplete", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
    await createCompletedFirstGeneration(generationsRoot, false);

    await expect(
      createGeneration({
        repositoryRoot,
        generationsRoot,
        seasonId: "0001",
        generationId: "0002",
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).rejects.toThrow(/completed|incomplete/i);
    expect(await readdir(generationsRoot)).toEqual(["0001"]);
  });

  it("rejects a changed current enabled roster without creating generation two", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
    const copiedRepositoryRoot = await copyRepositoryForTest();
    await createCompletedFirstGeneration(generationsRoot, true, copiedRepositoryRoot);
    const contestantsConfigPath = join(copiedRepositoryRoot, "config/contestants.yaml");
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
        generationId: "0002",
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).rejects.toThrow(/roster|match/i);
    expect(await readdir(generationsRoot)).toEqual(["0001"]);
  });

  it("requires at least two enabled contestants at generation creation", async () => {
    const copiedRepositoryRoot = await copyRepositoryForTest();
    const contestantsConfigPath = join(copiedRepositoryRoot, "config/contestants.yaml");
    const contestantsConfig = await readFile(contestantsConfigPath, "utf8");
    await writeFile(
      contestantsConfigPath,
      contestantsConfig
        .replace(/(- id: fixture-geometric[\s\S]*? {4}enabled:) true/u, "$1 false")
        .replace(/(- id: fixture-generic[\s\S]*? {4}enabled:) true/u, "$1 false"),
      "utf8",
    );
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));

    await expect(
      createGeneration({
        repositoryRoot: copiedRepositoryRoot,
        generationsRoot,
        seasonId: "0001",
        generationId: "0001",
        now: timestamp,
      }),
    ).rejects.toThrow(/at least two enabled/i);
    await expect(stat(join(generationsRoot, "0001"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a previous leaderboard whose contestant roster differs", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
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
        generationId: "0002",
        now: "2026-08-28T20:00:00.000Z",
      }),
    ).rejects.toThrow(/leaderboard|roster/i);
    expect(await readdir(generationsRoot)).toEqual(["0001"]);
  });

  it("allows only one concurrent creator to win a generation collision", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-generations-"));
    const options = {
      repositoryRoot,
      generationsRoot,
      seasonId: "0001" as const,
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
