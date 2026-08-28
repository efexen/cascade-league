import { cp, chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { createGeneration } from "../../src/artifacts/generation.js";
import { buildGallery } from "../../src/gallery/builder.js";
import { runGeneration } from "../../src/orchestration/generation.js";
import {
  IdentitySchema,
  LeaderboardSchema,
  ManifestSchema,
  RunSchema,
  ValidationSchema,
} from "../../src/schemas/index.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const timestamp = "2026-08-28T20:00:00.000Z";

async function createCompletedFixtureGeneration(
  generationsRoot: string,
  root = repositoryRoot,
) {
  const generation = await createGeneration({
    repositoryRoot: root,
    generationsRoot,
    seasonId: "0001",
    generationId: "0001",
    now: timestamp,
  });
  const result = await runGeneration({
    repositoryRoot: root,
    generationPath: generation.generationPath,
    generatedAt: timestamp,
  });
  return { generation, result };
}

async function appendChampionCss(
  generationPath: string,
  contestantId: string,
  cssRule: string,
): Promise<void> {
  const contestantPath = join(generationPath, "contestants", contestantId);
  const submissionPath = join(contestantPath, "submission.css");
  const submission = Buffer.concat([
    await readFile(submissionPath),
    Buffer.from(`\n${cssRule}\n`, "utf8"),
  ]);
  await writeFile(submissionPath, submission);
  const submissionSha256 = createHash("sha256").update(submission).digest("hex");
  const validationPath = join(contestantPath, "validation.json");
  const validation = ValidationSchema.parse(
    JSON.parse(await readFile(validationPath, "utf8")) as unknown,
  );
  await writeFile(
    validationPath,
    `${JSON.stringify(
      ValidationSchema.parse({
        ...validation,
        submissionSha256,
        sanitisedSha256: submissionSha256,
        submissionBytes: submission.byteLength,
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("static public gallery", () => {
  it("rejects partial and extra leaderboard contestant sets", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-gallery-set-"));
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: timestamp,
    });
    const leaderboard = LeaderboardSchema.parse(
      JSON.parse(
        await readFile(join(generation.generationPath, "leaderboard.json"), "utf8"),
      ) as unknown,
    );
    const partial = LeaderboardSchema.parse({
      ...leaderboard,
      entries: leaderboard.entries.slice(0, -1),
    });
    await expect(
      buildGallery({
        repositoryRoot,
        generationPath: generation.generationPath,
        leaderboard: partial,
      }),
    ).rejects.toThrow(/contestant|manifest|set/i);

    const extra = LeaderboardSchema.parse({
      ...leaderboard,
      entries: [
        ...leaderboard.entries,
        {
          rank: null,
          contestantId: "unknown-contestant",
          displayName: "Unknown Contestant",
          harnessName: "Unknown Harness",
          modelName: "Unknown Model",
          status: "execution_failed",
          screenshotPath: null,
          combinedScore: null,
          medianScore: null,
          originalityScore: null,
          completedJudgeCount: 0,
          expectedJudgeCount: leaderboard.expectedJudgeCount,
          judgeScores: [],
          awards: [],
          failure: "unknown contestant",
        },
      ],
    });
    await expect(
      buildGallery({
        repositoryRoot,
        generationPath: generation.generationPath,
        leaderboard: extra,
      }),
    ).rejects.toThrow(/contestant|manifest|set/i);
  }, 30000);

  it("rejects a leaderboard identity whose contestant ID differs from its directory", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-gallery-identity-integrity-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: timestamp,
    });
    await runGeneration({
      repositoryRoot,
      generationPath: generation.generationPath,
      generatedAt: timestamp,
    });
    const identityPath = join(
      generation.generationPath,
      "contestants/fixture-editorial/identity.json",
    );
    const identity = IdentitySchema.parse(
      JSON.parse(await readFile(identityPath, "utf8")) as unknown,
    );
    await writeFile(
      identityPath,
      `${JSON.stringify({ ...identity, contestantId: "fixture-geometric" }, null, 2)}\n`,
      "utf8",
    );

    await expect(
      buildGallery({ repositoryRoot, generationPath: generation.generationPath }),
    ).rejects.toThrow(/identity|contestant|directory/i);
  }, 30000);

  it("rejects a leaderboard status that disagrees with complete judge artifacts", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-gallery-status-integrity-"),
    );
    const { generation } = await createCompletedFixtureGeneration(generationsRoot);
    const leaderboard = LeaderboardSchema.parse(
      JSON.parse(
        await readFile(join(generation.generationPath, "leaderboard.json"), "utf8"),
      ) as unknown,
    );
    const champion = leaderboard.entries.find((entry) => entry.rank === 1);
    expect(champion).toBeDefined();
    if (champion === undefined) throw new Error("fixture generation has no champion");
    const forged = LeaderboardSchema.parse({
      ...leaderboard,
      entries: leaderboard.entries.map((entry) =>
        entry.contestantId === champion.contestantId
          ? { ...entry, status: "judge_incomplete" }
          : entry,
      ),
    });

    await expect(
      buildGallery({
        repositoryRoot,
        generationPath: generation.generationPath,
        leaderboard: forged,
      }),
    ).rejects.toThrow(/status|judge/i);
  }, 30000);

  it("falls back when champion CSS hides populated gallery content", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-gallery-visibility-fallback-"),
    );
    const { generation, result: completed } =
      await createCompletedFixtureGeneration(generationsRoot);
    const champion = completed.leaderboard.entries.find(
      (entry) => entry.rank === 1 && entry.status === "valid",
    );
    expect(champion).toBeDefined();
    if (champion === undefined) throw new Error("fixture generation has no champion");
    await appendChampionCss(
      generation.generationPath,
      champion.contestantId,
      ".judge-note, .entry-scores, .entry-awards { display:none !important; }",
    );

    const result = await buildGallery({
      repositoryRoot,
      generationPath: generation.generationPath,
    });

    expect(result).toMatchObject({
      championContestantId: champion.contestantId,
      stylesheetKind: "fallback",
    });
    expect(await readFile(join(result.publicPath, "champion.css"))).toEqual(
      await readFile(join(generation.generationPath, "challenge/fallback.css")),
    );
    expect(await readFile(join(result.publicPath, "metadata.json"), "utf8")).toContain(
      "could not safely present required public content",
    );
    const html = await readFile(join(result.publicPath, "index.html"), "utf8");
    expect(html).toContain("Combined");
    expect(html).toContain("Judge notes");
    expect(
      (await readdir(generation.generationPath)).filter((name) =>
        name.startsWith(".public.build-"),
      ),
    ).toEqual([]);
  }, 30000);

  it.each([
    ["ancestor opacity", ".leaderboard-grid { opacity: 0 !important; }"],
    [
      "off-document positioning",
      ".entry-card { position: absolute !important; left: -100000px !important; }",
    ],
    [
      "individually hidden judge dimension rows",
      ".judge-dimension-scores > div { display: none !important; }",
    ],
    [
      "hidden candidate identity",
      ".entry-rank, .entry-title, .entry-identity { display: none !important; }",
    ],
    [
      "hidden judge score details",
      ".judge-score, .judge-dimension-scores { display: none !important; }",
    ],
  ])(
    "falls back for %s champion CSS",
    async (_name, cssRule) => {
      const generationsRoot = await mkdtemp(
        join(tmpdir(), "local-maxima-gallery-visibility-adversarial-"),
      );
      const { generation, result: completed } =
        await createCompletedFixtureGeneration(generationsRoot);
      const champion = completed.leaderboard.entries.find(
        (entry) => entry.rank === 1 && entry.status === "valid",
      );
      expect(champion).toBeDefined();
      if (champion === undefined) throw new Error("fixture generation has no champion");
      await appendChampionCss(
        generation.generationPath,
        champion.contestantId,
        cssRule,
      );

      const built = await buildGallery({
        repositoryRoot,
        generationPath: generation.generationPath,
      });
      expect(built.championContestantId).toBe(champion.contestantId);
      expect(built.stylesheetKind).toBe("fallback");
      expect(await readFile(join(built.publicPath, "champion.css"))).toEqual(
        await readFile(join(generation.generationPath, "challenge/fallback.css")),
      );
      const html = await readFile(join(built.publicPath, "index.html"), "utf8");
      expect(html).toContain("Combined");
      expect(html).toContain("Judge notes");
      expect(
        (await readdir(generation.generationPath)).filter((name) =>
          name.startsWith(".public.build-"),
        ),
      ).toEqual([]);
    },
    30000,
  );

  it("formats repeating three-judge aggregate means with exactly two decimals", async () => {
    const repositoryParent = await mkdtemp(
      join(tmpdir(), "local-maxima-gallery-decimal-repository-"),
    );
    const temporaryRepository = join(repositoryParent, "repository");
    await cp(repositoryRoot, temporaryRepository, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${join("", "node_modules")}/`) &&
        !source.endsWith(`${join("", "node_modules")}`) &&
        !source.includes(`${join("", ".git")}/`) &&
        !source.endsWith(`${join("", ".git")}`),
    });
    const judgesPath = join(temporaryRepository, "config/judges.yaml");
    await writeFile(
      judgesPath,
      `${await readFile(judgesPath, "utf8")}\n  - id: fixture-critic-c\n    displayName: Fixture Critic C\n    harness:\n      name: fixture-judge\n      version: "1.0.0"\n      adapter: fixture\n      fixture: critic-a\n    model:\n      provider: local-fixture\n      name: critic-c-model\n      version: "1.0.0"\n    budget:\n      timeoutMs: 180000\n      maximumOutputTokens: 4000\n    enabled: true\n`,
      "utf8",
    );
    const generationsRoot = join(repositoryParent, "generations");
    const generation = await createGeneration({
      repositoryRoot: temporaryRepository,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: timestamp,
    });
    const result = await runGeneration({
      repositoryRoot: temporaryRepository,
      generationPath: generation.generationPath,
      generatedAt: "2026-08-28T20:15:00.000Z",
    });
    const html = await readFile(join(result.gallery.publicPath, "index.html"), "utf8");

    expect(result.leaderboard.entries[0]?.completedJudgeCount).toBe(3);
    expect(html).toContain("89.67");
    expect(html).toContain("13.67");
    expect(html).toContain("10.00");
    expect(html).not.toContain("89.66666666666667");
    expect(html).not.toContain("13.666666666666666");
  }, 30000);

  it("copies the champion stylesheet exactly and captures an exact-size share image", async () => {
    const generationsRoot = await mkdtemp(join(tmpdir(), "local-maxima-gallery-"));
    const { generation, result } =
      await createCompletedFixtureGeneration(generationsRoot);
    const champion = result.leaderboard.entries.find(
      (entry) => entry.contestantId === result.gallery.championContestantId,
    );
    expect(champion).toBeDefined();
    if (champion === undefined) throw new Error("fixture generation has no champion");
    const sourceCss = await readFile(
      join(
        generation.generationPath,
        "contestants",
        champion.contestantId,
        "submission.css",
      ),
    );

    expect(
      await readFile(join(generation.generationPath, "public/champion.css")),
    ).toEqual(sourceCss);
    expect(
      await sharp(
        join(generation.generationPath, "public/gallery-screenshot.png"),
      ).metadata(),
    ).toMatchObject({ format: "png", width: 1440, height: 1200 });
    expect((await readdir(join(generation.generationPath, "public"))).sort()).toEqual([
      "champion.css",
      "fonts",
      "gallery-screenshot.png",
      "index.html",
      "metadata.json",
      "screenshots",
    ]);
    expect(
      await readdir(join(generation.generationPath, "public/screenshots")),
    ).toEqual(["entry-001.png", "entry-002.png", "entry-003.png"]);
    expect(
      (await readdir(join(generation.generationPath, "public/fonts"))).every((file) =>
        file.endsWith(".ttf"),
      ),
    ).toBe(true);
    expect(
      await readdir(join(generation.generationPath, "public"), {
        withFileTypes: true,
      }),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "anonymous-map.json" }),
        expect.objectContaining({ name: "logs" }),
        expect.objectContaining({ name: "raw" }),
      ]),
    );
  }, 30000);

  it("escapes model strings while preserving the script-free local-resource policy", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-gallery-escape-"),
    );
    const { generation } = await createCompletedFixtureGeneration(generationsRoot);
    const leaderboardPath = join(generation.generationPath, "leaderboard.json");
    const leaderboard = LeaderboardSchema.parse(
      JSON.parse(await readFile(leaderboardPath, "utf8")) as unknown,
    );
    const target = leaderboard.entries.find(
      (entry) => entry.rank === 1 && entry.status === "valid",
    );
    expect(target).toBeDefined();
    if (target === undefined) throw new Error("fixture generation has no champion");
    const identityPath = join(
      generation.generationPath,
      "contestants",
      target.contestantId,
      "identity.json",
    );
    const identity = IdentitySchema.parse(
      JSON.parse(await readFile(identityPath, "utf8")) as unknown,
    );
    const escapedIdentity = {
      ...identity,
      displayName: "<script>alert(1)</script> & {{danger}} https://example.invalid",
      harness: { ...identity.harness, name: "Fixture & <harness>" },
      model: { ...identity.model, name: 'Model "quoted"' },
    };
    await writeFile(
      identityPath,
      `${JSON.stringify(escapedIdentity, null, 2)}\n`,
      "utf8",
    );
    const firstJudge = target.judgeScores[0];
    expect(firstJudge).toBeDefined();
    if (firstJudge === undefined)
      throw new Error("fixture champion has no judge score");
    const escapedLeaderboard = LeaderboardSchema.parse({
      ...leaderboard,
      entries: leaderboard.entries.map((entry) =>
        entry.contestantId !== target.contestantId
          ? entry
          : {
              ...entry,
              displayName: escapedIdentity.displayName,
              harnessName: escapedIdentity.harness.name,
              modelName: escapedIdentity.model.name,
              judgeScores: entry.judgeScores.map((score) =>
                score.judgeId !== firstJudge.judgeId
                  ? score
                  : {
                      ...score,
                      strongestQuality: "<strong>Strong</strong> & {{quality}}",
                      primaryWeakness: 'Weak "point" <em>here</em>',
                      nextMove: "Next <script>alert(4)</script> move",
                      critique:
                        '<b>Good</b> & "quoted". {{template}} https://example.invalid <script>alert(2)</script>',
                    },
              ),
              awards: [
                {
                  judgeId: firstJudge.judgeId,
                  label: "Best <style>",
                  rationale: "& <script>alert(3)</script> {{award}}.",
                },
              ],
            },
      ),
    });
    await writeFile(
      identityPath,
      `${JSON.stringify(IdentitySchema.parse(escapedIdentity), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      leaderboardPath,
      `${JSON.stringify(escapedLeaderboard, null, 2)}\n`,
      "utf8",
    );
    await buildGallery({
      repositoryRoot,
      generationPath: generation.generationPath,
    });
    const html = await readFile(
      join(generation.generationPath, "public/index.html"),
      "utf8",
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;strong&gt;Strong&lt;/strong&gt;");
    expect(html).toContain("Next &lt;script&gt;alert(4)&lt;/script&gt; move");
    expect(html).not.toMatch(/<script\b/iu);
    expect(html).toContain("script-src 'none'");
    expect(html).not.toMatch(/\b(?:src|href)=["'](?:https?:|\/\/)/iu);
  }, 30000);

  it("builds a fallback gallery without inventing a champion score", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-gallery-fallback-"),
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      generationId: "0001",
      now: timestamp,
    });
    const manifestPath = join(generation.generationPath, "manifest.json");
    const manifest = ManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    );
    for (const [index, contestantId] of manifest.contestantIds.entries()) {
      const contestantPath = join(
        generation.generationPath,
        "contestants",
        contestantId,
      );
      const runPath = join(contestantPath, "run.json");
      const run = RunSchema.parse(
        JSON.parse(await readFile(runPath, "utf8")) as unknown,
      );
      await writeFile(
        runPath,
        `${JSON.stringify(
          RunSchema.parse({
            ...run,
            status: "succeeded",
            startedAt: timestamp,
            completedAt: timestamp,
            durationMs: 0,
            exitCode: 0,
            attemptCount: 1,
          }),
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        join(contestantPath, "validation.json"),
        `${JSON.stringify(
          ValidationSchema.parse({
            schemaVersion: 1,
            status: "invalid",
            submissionSha256: null,
            sanitisedSha256: null,
            submissionBytes: 0,
            staticChecks: [],
            renderChecks: [],
            errors: [index === 0 ? "CSS validation failed" : "No valid judge result"],
            warnings: [],
          }),
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
    const identities = await Promise.all(
      manifest.contestantIds.map(async (contestantId) =>
        IdentitySchema.parse(
          JSON.parse(
            await readFile(
              join(
                generation.generationPath,
                "contestants",
                contestantId,
                "identity.json",
              ),
              "utf8",
            ),
          ) as unknown,
        ),
      ),
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, status: "completed", completedAt: timestamp }, null, 2)}\n`,
    );
    const leaderboard = LeaderboardSchema.parse({
      schemaVersion: 1,
      seasonId: "0001",
      generationId: "0001",
      generatedAt: timestamp,
      rankingMethod: "mean-valid-judge-score-v1",
      expectedJudgeCount: manifest.judgeIds.length,
      entries: identities.map((identity, index) => ({
        rank: null,
        contestantId: identity.contestantId,
        displayName: identity.displayName,
        harnessName: identity.harness.name,
        modelName: identity.model.name,
        status: "invalid",
        screenshotPath: null,
        combinedScore: null,
        medianScore: null,
        originalityScore: null,
        completedJudgeCount: 0,
        expectedJudgeCount: manifest.judgeIds.length,
        judgeScores: [],
        awards: [],
        failure: index === 0 ? "CSS validation failed" : "No valid judge result",
      })),
    });
    const built = await buildGallery({
      repositoryRoot,
      generationPath: generation.generationPath,
      leaderboard,
    });
    expect(built.championContestantId).toBeNull();
    expect(built.stylesheetKind).toBe("fallback");
    expect(
      await readFile(join(generation.generationPath, "public/champion.css")),
    ).toEqual(
      await readFile(join(generation.generationPath, "challenge/fallback.css")),
    );
    const html = await readFile(
      join(generation.generationPath, "public/index.html"),
      "utf8",
    );
    expect(html).toContain("No champion");
    expect(html).toContain("CSS validation failed");
    expect(html).toContain("No valid judge result");
    expect(
      await readFile(join(generation.generationPath, "public/metadata.json"), "utf8"),
    ).toContain('"stylesheetKind": "fallback"');
  }, 30000);

  it("rejects a changed resolved challenge before rebuilding public output", async () => {
    const generationsRoot = await mkdtemp(
      join(tmpdir(), "local-maxima-gallery-integrity-"),
    );
    const { generation } = await createCompletedFixtureGeneration(generationsRoot);
    const challengePath = join(generation.generationPath, "challenge/challenge.html");
    await chmod(challengePath, 0o644);
    await writeFile(
      challengePath,
      `${await readFile(challengePath, "utf8")}\n<!-- changed -->\n`,
    );

    await expect(
      buildGallery({
        repositoryRoot,
        generationPath: generation.generationPath,
      }),
    ).rejects.toThrow("generation challenge asset challenge.html");
  });
});
