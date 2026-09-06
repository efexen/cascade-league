import { cp, chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import sharp from "sharp";

import { createGeneration } from "../../src/artifacts/generation.js";
import { buildGallery } from "../../src/gallery/builder.js";
import { runGeneration } from "../../src/orchestration/generation.js";
import {
  AnonymousMapSchema,
  IdentitySchema,
  LeaderboardSchema,
  ManifestSchema,
  RunSchema,
  TaskStateSchema,
  ValidationSchema,
  type Leaderboard,
} from "../../src/schemas/index.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

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
    profileId: "fixture",
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
  await writeFile(join(contestantPath, "sanitised.css"), submission);
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

async function filesUnder(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(directory, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function publicBytes(publicPath: string): Promise<Buffer> {
  const files = (await filesUnder(publicPath)).filter(
    (relativePath) => !/\.(?:png|ttf)$/iu.test(relativePath),
  );
  const contents = await Promise.all(
    files.map(async (relativePath) => readFile(join(publicPath, relativePath))),
  );
  return Buffer.concat(contents);
}

function matrixMarkup(html: string): string {
  const start = html.indexOf('<table class="judge-matrix">');
  const end = html.indexOf("</table>", start);
  if (start < 0 || end < 0) throw new Error("public judge matrix is missing");
  return html.slice(start, end + "</table>".length);
}

function recomputeLeaderboardEvidence(
  entry: Leaderboard["entries"][number],
  judgeScores: Leaderboard["entries"][number]["judgeScores"],
): Leaderboard["entries"][number] {
  const base = { ...entry };
  delete base.dimensionMeans;
  delete base.meanHierarchyAndReadability;
  const totals = judgeScores.map((score) => score.totalScore);
  const originalityScores = judgeScores.map((score) => score.originalityScore);
  const combinedScore =
    totals.length === 0
      ? null
      : totals.reduce((sum, score) => sum + score, 0) / totals.length;
  const sortedTotals = [...totals].sort((left, right) => left - right);
  const medianScore =
    sortedTotals.length === 0
      ? null
      : sortedTotals.length % 2 === 1
        ? sortedTotals[Math.floor(sortedTotals.length / 2)]!
        : (sortedTotals[sortedTotals.length / 2 - 1]! +
            sortedTotals[sortedTotals.length / 2]!) /
          2;
  const minimumScore = totals.length === 0 ? null : Math.min(...totals);
  const maximumScore = totals.length === 0 ? null : Math.max(...totals);
  const scoreRange =
    minimumScore === null || maximumScore === null ? null : maximumScore - minimumScore;
  const standardDeviation =
    combinedScore === null
      ? null
      : Math.sqrt(
          totals.reduce((sum, score) => sum + (score - combinedScore) ** 2, 0) /
            totals.length,
        );
  const dimensionEvidence =
    judgeScores.length > 0 && judgeScores.every((score) => score.scores !== undefined);
  const dimensionMeans:
    | NonNullable<Leaderboard["entries"][number]["dimensionMeans"]>
    | undefined = dimensionEvidence
    ? {
        hierarchyAndReadability:
          judgeScores.reduce(
            (sum, score) => sum + score.scores!.hierarchyAndReadability,
            0,
          ) / judgeScores.length,
        composition:
          judgeScores.reduce((sum, score) => sum + score.scores!.composition, 0) /
          judgeScores.length,
        typography:
          judgeScores.reduce((sum, score) => sum + score.scores!.typography, 0) /
          judgeScores.length,
        colourAndVisualSystem:
          judgeScores.reduce(
            (sum, score) => sum + score.scores!.colourAndVisualSystem,
            0,
          ) / judgeScores.length,
        coherenceAndCraft:
          judgeScores.reduce((sum, score) => sum + score.scores!.coherenceAndCraft, 0) /
          judgeScores.length,
        originalityAndMemorability:
          judgeScores.reduce(
            (sum, score) => sum + score.scores!.originalityAndMemorability,
            0,
          ) / judgeScores.length,
        constraintAndCssCraft:
          judgeScores.reduce(
            (sum, score) => sum + score.scores!.constraintAndCssCraft,
            0,
          ) / judgeScores.length,
      }
    : undefined;
  return {
    ...base,
    combinedScore,
    medianScore,
    originalityScore:
      originalityScores.length === 0
        ? null
        : originalityScores.reduce((sum, score) => sum + score, 0) /
          originalityScores.length,
    minimumScore,
    maximumScore,
    scoreRange,
    standardDeviation,
    completedJudgeCount: judgeScores.length,
    judgeScores,
    ...(dimensionEvidence
      ? {
          meanHierarchyAndReadability: dimensionMeans!.hierarchyAndReadability,
          dimensionMeans,
        }
      : {}),
  };
}

describe("static public gallery", () => {
  it("renders operational labels and the exact configured judge matrix", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-gallery-presentation-integration-",
    );
    const { generation, result } =
      await createCompletedFixtureGeneration(generationsRoot);
    const html = await readFile(join(result.gallery.publicPath, "index.html"), "utf8");
    const leaderboard = result.leaderboard;

    expect((html.match(/class="entry-runtime\b/g) ?? []).length).toBe(3);
    expect((html.match(/class="entry-estimated-cost\b/g) ?? []).length).toBe(3);
    expect(html).toContain("Runtime");
    expect(html).toContain("Estimated cost");
    expect(html).toContain('<table class="judge-matrix">');
    expect(html).toContain('<th scope="col">Fixture Critic A</th>');
    expect(html).toContain('<th scope="col">Fixture Critic B</th>');
    expect(
      [
        ...html.matchAll(
          /<tr class="judge-matrix-row"[^>]*data-contestant-id="([^"]+)"/g,
        ),
      ].map((match) => match[1]),
    ).toEqual(leaderboard.entries.map((entry) => entry.contestantId));
    expect(html.indexOf('<table class="judge-matrix">')).toBeLessThan(
      html.indexOf('<article id="entry-detail-'),
    );
    expect(await readdir(join(generation.generationPath, "public"))).not.toContain(
      "run.json",
    );
    expect(html).not.toContain("run-summary");
  }, 30000);

  it("rejects contradictory leaderboard evidence before selecting a champion", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-gallery-integrity-");
    const { generation } = await createCompletedFixtureGeneration(generationsRoot);
    const leaderboard = LeaderboardSchema.parse(
      JSON.parse(
        await readFile(join(generation.generationPath, "leaderboard.json"), "utf8"),
      ) as unknown,
    );
    const firstEntry = leaderboard.entries[0]!;
    const contradictory = LeaderboardSchema.parse({
      ...leaderboard,
      entries: [
        { ...firstEntry, combinedScore: firstEntry.combinedScore! + 1 },
        ...leaderboard.entries.slice(1),
      ],
    });

    await expect(
      buildGallery({
        repositoryRoot,
        generationPath: generation.generationPath,
        leaderboard: contradictory,
      }),
    ).rejects.toThrow(/combined|aggregate|evidence/i);
  }, 30000);

  it("renders missing, invalid, and timed-out judge states in the final matrix DOM", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-gallery-matrix-states-",
    );
    const { generation } = await createCompletedFixtureGeneration(generationsRoot);
    const manifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(join(generation.generationPath, "manifest.json"), "utf8"),
      ) as unknown,
    );
    const leaderboard = LeaderboardSchema.parse(
      JSON.parse(
        await readFile(join(generation.generationPath, "leaderboard.json"), "utf8"),
      ) as unknown,
    );
    const anonymousMap = AnonymousMapSchema.parse(
      JSON.parse(
        await readFile(
          join(generation.generationPath, "judging/anonymous-map.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const mutations = [
      {
        contestantId: manifest.contestantIds[0]!,
        judgeId: "fixture-critic-a",
        state: "missing" as const,
      },
      {
        contestantId: manifest.contestantIds[1]!,
        judgeId: "fixture-critic-b",
        state: "invalid" as const,
      },
      {
        contestantId: manifest.contestantIds[2]!,
        judgeId: "fixture-critic-a",
        state: "timeout" as const,
      },
    ];

    for (const mutation of mutations) {
      const anonymousCandidateId = anonymousMap.entries.find(
        (entry) => entry.contestantId === mutation.contestantId,
      )?.anonymousCandidateId;
      expect(anonymousCandidateId).toBeDefined();
      if (anonymousCandidateId === undefined) throw new Error("anonymous ID missing");
      const taskPath = join(
        generation.generationPath,
        "judging",
        mutation.judgeId,
        "tasks",
        `${anonymousCandidateId}.json`,
      );
      if (mutation.state === "missing") {
        await rm(taskPath);
      } else {
        const task = TaskStateSchema.parse(
          JSON.parse(await readFile(taskPath, "utf8")) as unknown,
        );
        await writeFile(
          taskPath,
          `${JSON.stringify(
            TaskStateSchema.parse({
              ...task,
              status: mutation.state,
              requestAccepted: false,
              error: null,
            }),
            null,
            2,
          )}\n`,
          "utf8",
        );
      }
    }

    const mutatedLeaderboard = LeaderboardSchema.parse({
      ...leaderboard,
      entries: leaderboard.entries.map((entry, index) => {
        const mutation = mutations[index];
        if (mutation === undefined) return entry;
        const judgeScores = entry.judgeScores.filter(
          (score) => score.judgeId !== mutation.judgeId,
        );
        return recomputeLeaderboardEvidence(
          {
            ...entry,
            status: "judge_incomplete" as const,
          },
          judgeScores,
        );
      }),
    });
    const built = await buildGallery({
      repositoryRoot,
      generationPath: generation.generationPath,
      leaderboard: mutatedLeaderboard,
    });
    const html = await readFile(join(built.publicPath, "index.html"), "utf8");
    const matrix = matrixMarkup(html);
    expect((matrix.match(/data-status="missing"/g) ?? []).length).toBe(1);
    expect((matrix.match(/data-status="invalid"/g) ?? []).length).toBe(1);
    expect((matrix.match(/data-status="timed_out"/g) ?? []).length).toBe(1);
    expect(matrix).toContain(">Missing</td>");
    expect(matrix).toContain(">Invalid</td>");
    expect(matrix).toContain(">Timed out</td>");
    const rows = [...matrix.matchAll(/<tr class="judge-matrix-row"[\s\S]*?<\/tr>/g)];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect((row[0]!.match(/<td\b/g) ?? []).length).toBe(4);
    }
  }, 30000);

  it("publishes only allowlisted operational values", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-gallery-privacy-allowlist-",
    );
    const { generation, result } =
      await createCompletedFixtureGeneration(generationsRoot);
    const sentinels = [
      "fixture-request-sentinel",
      "judge-cost-sentinel-987.654321",
      "executable-path-sentinel-/private/harness",
      "environment-variable-sentinel-PROVIDER_SECRET",
      "prompt-text-sentinel-do-not-publish",
      "log-text-sentinel-private-diagnostic",
      "log-path-sentinel-/private/logs/task.log",
      "raw-task-error-sentinel",
      "contestant-token-sentinel-111111",
      "judge-token-sentinel-222222",
    ];
    await writeFile(
      join(generation.generationPath, "logs/privacy-sentinels.txt"),
      sentinels.join("\n"),
      "utf8",
    );
    await writeFile(
      join(
        generation.generationPath,
        "contestants/fixture-editorial/private-prompt.txt",
      ),
      sentinels[4]!,
      "utf8",
    );
    await writeFile(
      join(
        generation.generationPath,
        "judging/fixture-critic-a/private-execution-metadata.json",
      ),
      JSON.stringify({ providerRequestId: sentinels[0] }),
      "utf8",
    );
    await writeFile(
      join(
        generation.generationPath,
        "contestants/fixture-editorial/private-usage.json",
      ),
      JSON.stringify({
        inputTokens: sentinels[8],
        outputTokens: sentinels[8],
        estimatedCostUsd: sentinels[1],
        executablePath: sentinels[2],
        environmentVariable: sentinels[3],
      }),
      "utf8",
    );
    await writeFile(
      join(generation.generationPath, "judging/fixture-critic-a/private-usage.json"),
      JSON.stringify({
        inputTokens: sentinels[9],
        outputTokens: sentinels[9],
        estimatedCostUsd: sentinels[1],
        error: sentinels[7],
      }),
      "utf8",
    );

    await buildGallery({
      repositoryRoot,
      generationPath: generation.generationPath,
    });

    const publicContent = (await publicBytes(result.gallery.publicPath)).toString(
      "utf8",
    );
    expect(publicContent).toContain("Runtime");
    expect(publicContent).toContain("Estimated cost");
    expect(publicContent).toContain("—");
    expect(publicContent).not.toMatch(
      /fixture-request-sentinel|providerRequestId|contestant-token-sentinel|judge-token-sentinel|inputTokens|outputTokens|reasoningTokens|totalTokens|judge-cost-sentinel|executable-path-sentinel|environment-variable-sentinel|prompt-text-sentinel|log-text-sentinel|log-path-sentinel|raw-task-error-sentinel/iu,
    );
  }, 30000);

  it("escapes adversarial judge and configuration labels in the matrix", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-gallery-judge-label-escape-",
    );
    const { generation } = await createCompletedFixtureGeneration(generationsRoot);
    const judgesPath = join(generation.generationPath, "config/judges.yaml");
    const hostileJudgeA =
      '<img src="https://evil.invalid/x" onerror="alert(1)"> & "quoted" {{judge}}';
    const hostileJudgeB =
      "<script>alert(2)</script> 'single' https://evil.invalid/{{url}}";
    const judgesYaml = (await readFile(judgesPath, "utf8"))
      .replace(
        "displayName: Fixture Critic A",
        `displayName: ${JSON.stringify(hostileJudgeA)}`,
      )
      .replace(
        "displayName: Fixture Critic B",
        `displayName: ${JSON.stringify(hostileJudgeB)}`,
      );
    await writeFile(judgesPath, judgesYaml, "utf8");

    const manifestPath = join(generation.generationPath, "manifest.json");
    const manifest = ManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          configHashes: {
            ...manifest.configHashes,
            judges: createHash("sha256").update(judgesYaml).digest("hex"),
          },
        },
        null,
        2,
      )}\n`,
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
    expect(html).toContain("&lt;img src&#x3D;&quot;https://evil.invalid/x&quot;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).not.toContain('<img src="https://evil.invalid/x"');
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).not.toMatch(/\b(?:src|href)=["'](?:https?:|\/\/)/iu);
  }, 30000);

  it("rejects partial and extra leaderboard contestant sets", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-gallery-set-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
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
    const generationsRoot = await createTestTempRoot(
      "local-maxima-gallery-identity-integrity-",
    );
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
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
    const generationsRoot = await createTestTempRoot(
      "local-maxima-gallery-status-integrity-",
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
    const generationsRoot = await createTestTempRoot(
      "local-maxima-gallery-visibility-fallback-",
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

  it("falls back when champion CSS hides the matrix or operational labels", async () => {
    const hostileRules = [
      ".judge-matrix { display: none !important; }",
      ".judge-matrix-row { opacity: 0 !important; }",
      ".judge-matrix-cell { visibility: hidden !important; }",
      ".judge-matrix-combined { position: absolute !important; left: -100000px !important; }",
      ".judge-matrix-range { visibility: hidden !important; }",
      ".entry-runtime, .entry-estimated-cost { display: none !important; }",
      ".judge-notes { width: 0 !important; height: 0 !important; overflow: hidden !important; }",
      '.judge-matrix-cell[data-status="score"] { padding-top: 100000px !important; }',
      '.judge-matrix-cell[data-status="score"] { position: relative !important; } .judge-matrix-cell[data-status="score"]::after { content: ""; position: absolute; inset: 0; z-index: 1; background: #111 !important; }',
    ];

    for (const [index, cssRule] of hostileRules.entries()) {
      const generationsRoot = await createTestTempRoot(
        `local-maxima-gallery-new-visibility-${String(index)}-`,
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
      expect(html).toContain('class="judge-matrix"');
      expect(html).toContain("Runtime");
      expect(html).toContain("Estimated cost");
    }
  }, 120000);

  it("keeps champion CSS with a benign thumbnail clip path", async () => {
    const generationsRoot = await createTestTempRoot(
      "local-maxima-gallery-benign-clip-",
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
      ".entry-thumbnail { clip-path: circle(50%); }",
    );

    const built = await buildGallery({
      repositoryRoot,
      generationPath: generation.generationPath,
    });
    expect(built.stylesheetKind).toBe("champion");
    await expect(readFile(join(built.publicPath, "champion.css"))).resolves.toEqual(
      await readFile(
        join(
          generation.generationPath,
          "contestants",
          champion.contestantId,
          "submission.css",
        ),
      ),
    );
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
      const generationsRoot = await createTestTempRoot(
        "local-maxima-gallery-visibility-adversarial-",
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
    const repositoryParent = await createTestTempRoot(
      "local-maxima-gallery-decimal-repository-",
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
    const judgesPath = join(temporaryRepository, "config/profiles/fixture/judges.yaml");
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
      profileId: "fixture",
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
    const generationsRoot = await createTestTempRoot("local-maxima-gallery-");
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
    ).toMatchObject({ format: "png", width: 1280 });
    expect(
      (
        await sharp(
          join(generation.generationPath, "public/gallery-screenshot.png"),
        ).metadata()
      ).height,
    ).toBeGreaterThan(1200);
    expect(
      await sharp(
        join(generation.generationPath, "public/gallery-viewport.png"),
      ).metadata(),
    ).toMatchObject({ format: "png", width: 1280, height: 1200 });
    expect((await readdir(join(generation.generationPath, "public"))).sort()).toEqual([
      "champion.css",
      "designs",
      "fonts",
      "gallery-layout.css",
      "gallery-screenshot.png",
      "gallery-viewport.png",
      "index.html",
      "metadata.json",
      "screenshots",
    ]);
    expect(
      (await readdir(join(generation.generationPath, "public/screenshots"))).sort(),
    ).toEqual([
      "entry-001-full.png",
      "entry-001.png",
      "entry-002-full.png",
      "entry-002.png",
      "entry-003-full.png",
      "entry-003.png",
    ]);
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

  it("uses viewport captures for card previews and links to full designs", async () => {
    const generationsRoot = await createTestTempRoot("cascade-gallery-design-preview-");
    const { generation, result } =
      await createCompletedFixtureGeneration(generationsRoot);
    const firstEntry = result.leaderboard.entries[0];
    expect(firstEntry).toBeDefined();
    if (firstEntry === undefined) throw new Error("fixture generation has no entries");

    const previewPath = join(
      generation.generationPath,
      "public/screenshots/entry-001.png",
    );
    const fullPath = join(
      generation.generationPath,
      "public/screenshots/entry-001-full.png",
    );
    await expect(sharp(previewPath).metadata()).resolves.toMatchObject({
      format: "png",
      width: 1280,
      height: 1200,
    });
    const fullMetadata = await sharp(fullPath).metadata();
    expect(fullMetadata).toMatchObject({ format: "png", width: 1280 });
    expect(fullMetadata.height).toBeGreaterThan(1200);

    const html = await readFile(join(result.gallery.publicPath, "index.html"), "utf8");
    const designPath = `designs/${firstEntry.contestantId}`;
    expect(html).toContain('src="screenshots/entry-001.png"');
    expect(html).toContain(`href="${designPath}/index.html"`);
    expect(html).not.toContain('href="screenshots/entry-001-full.png"');
    expect(html).toMatch(/View\s+full design/u);
    await expect(
      readFile(join(result.gallery.publicPath, designPath, "index.html")),
    ).resolves.toEqual(
      await readFile(join(generation.generationPath, "challenge/challenge.html")),
    );
    await expect(
      readFile(join(result.gallery.publicPath, designPath, "submission.css")),
    ).resolves.toEqual(
      await readFile(
        join(
          generation.generationPath,
          "contestants",
          firstEntry.contestantId,
          "sanitised.css",
        ),
      ),
    );
    await expect(
      readFile(
        join(result.gallery.publicPath, designPath, "fonts/lm-display-sans.ttf"),
      ),
    ).resolves.toBeInstanceOf(Buffer);
    await expect(
      readFile(join(result.gallery.publicPath, designPath, "thumbnails/seed-01.png")),
    ).resolves.toBeInstanceOf(Buffer);

    const leaderboardMarkup = html.match(
      /<section[^>]+id="leaderboard"[\s\S]*?<\/section>/u,
    )?.[0];
    expect(leaderboardMarkup).toBeDefined();
    expect(leaderboardMarkup).toContain("Combined");
    expect(leaderboardMarkup).toContain("Originality");
    expect(leaderboardMarkup).not.toContain("Runtime");
    expect(leaderboardMarkup).not.toContain("Estimated cost");
    expect(leaderboardMarkup).not.toContain("Hierarchy");

    const judgeNotesMarkup = html.match(
      /<section[^>]+id="judge-notes"[\s\S]*?<\/section>/u,
    )?.[0];
    expect(judgeNotesMarkup).toContain("Runtime");
    expect(judgeNotesMarkup).toContain("Estimated cost");

    expect(html).toContain('href="gallery-layout.css"');
    await expect(
      readFile(join(result.gallery.publicPath, "gallery-layout.css"), "utf8"),
    ).resolves.toContain(".leaderboard-grid");

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
      await page.goto(`file://${join(result.gallery.publicPath, "index.html")}`);
      const cards = await page.locator(".entry-card").evaluateAll((nodes) =>
        nodes.map((node) => {
          const card = node.getBoundingClientRect();
          const visual = node.querySelector(".entry-visual")!.getBoundingClientRect();
          return {
            top: card.top,
            bottom: card.bottom,
            left: card.left,
            screenshotShare: visual.height / card.height,
          };
        }),
      );
      expect(cards).toHaveLength(3);
      expect(cards[1]!.top).toBeGreaterThan(cards[0]!.bottom);
      expect(cards[1]!.left).toBe(cards[0]!.left);
      expect(cards.every((card) => card.screenshotShare >= 0.88)).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30000);

  it("escapes model strings while preserving the script-free local-resource policy", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-gallery-escape-");
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
    const generationsRoot = await createTestTempRoot("local-maxima-gallery-fallback-");
    const generation = await createGeneration({
      repositoryRoot,
      generationsRoot,
      seasonId: "0001",
      profileId: "fixture",
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
    expect(html).toContain("This submission did not pass stylesheet validation.");
    expect(html).not.toContain("CSS validation failed");
    expect(html).not.toContain("No valid judge result");
    expect(
      await readFile(join(generation.generationPath, "public/metadata.json"), "utf8"),
    ).toContain('"stylesheetKind": "fallback"');
  }, 30000);

  it("rejects a changed resolved challenge before rebuilding public output", async () => {
    const generationsRoot = await createTestTempRoot("local-maxima-gallery-integrity-");
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
