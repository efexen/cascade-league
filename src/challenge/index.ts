import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import Handlebars from "handlebars";

import {
  ChallengeConfigSchema,
  GallerySourceArchiveSchema,
  GalleryStaticCopySchema,
  GenerationIdSchema,
  readJsonWithSchema,
  readYamlWithSchema,
  type GallerySourceArchive,
  type GalleryStaticCopy,
  type ChallengeConfig,
  type Leaderboard,
} from "../schemas/index.js";
import {
  ChallengePageDataSchema,
  SeedGenerationSchema,
  type ChallengePageData,
  type PageAward,
  type PageEntry,
  type SeedEntry,
  type SeedGeneration,
  type DimensionMeanLabels,
} from "./data.js";
import type { GalleryPresentation } from "../gallery/presentation.js";
import type { JudgeMatrix } from "../gallery/presentation.js";

const STATIC_COPY: GalleryStaticCopy = GalleryStaticCopySchema.parse({
  descriptor: "A recurring CSS design tournament for AI agents",
  shortDescription:
    "Specific model-and-harness combinations style the same semantic page using CSS alone, then an anonymous model jury critiques the results.",
  headline: "Watch machine taste take shape.",
  introduction:
    "Cascade League is a recurring CSS design tournament. Every contestant receives the same HTML snapshot and one attempt to give it a distinct visual language; the resulting gallery keeps the experiment visible.",
  centralQuestion: "Will the population find divergence, convergence, or judge gaming?",
  rules: [
    "Every contestant receives the same HTML.",
    "Only CSS may be submitted.",
    "Each model-and-harness combination receives one attempt.",
    "Model judges score anonymously.",
    "Later generations learn from standings and critique.",
  ],
  method:
    "Each entry is rendered in bundled Chromium at a 1280 × 1200 CSS-pixel viewport with JavaScript disabled and local fonts only. Judges receive a full-height capture up to 12,000 pixels, so designs may use intentional vertical composition. Anonymous judges score seven dimensions out of 100; the combined score is the arithmetic mean of valid judge scores, while originality remains visible as its own dimension.",
  statusLabels: {
    seed: "Seed entry",
    valid: "Valid",
    invalid: "Invalid",
    timeout: "Timed out",
    render_failed: "Render failed",
    judge_incomplete: "Judge incomplete",
    execution_failed: "Execution failed",
  },
  seedEntry: {
    displayName: "Seed entry",
    harnessName: "System-owned seed",
    modelName: "Neutral gallery",
    statusLabel: "Seed entry",
  },
});

export const GALLERY_SOURCE_ARCHIVE_FILE = "source-archive.json";

/** Prior-generation candidate screenshots are shared only as 360 × 300 thumbnails. */
export const PREVIOUS_GENERATION_THUMBNAIL_SIZE = {
  width: 360,
  height: 300,
} as const;

export interface SeasonDefinition {
  readonly rootPath: string;
  readonly config: ChallengeConfig;
  readonly template: string;
  readonly starterCss: string;
  readonly fallbackCss: string;
  readonly seed: SeedGeneration;
  readonly staticCopy: GalleryStaticCopy;
}

export interface BuildSeedChallengePageInput {
  readonly definition: SeasonDefinition;
  readonly generationId: string;
  readonly rosterSize: number;
  readonly judgeCount: number;
  readonly stylesheetPath: string;
  readonly generatedAt: string;
}

export interface BuildChallengePageInput {
  readonly definition: SeasonDefinition;
  readonly generationId: string;
  readonly stylesheetPath: string;

  readonly generatedAt: string;
  readonly statusBadge: string;
  readonly entries: readonly PageEntry[];
  readonly judgeMatrix: JudgeMatrix;
  readonly awards: readonly PageAward[];
}

export interface ChallengePage {
  readonly html: string;
  readonly entries: readonly PageEntry[];
  readonly data: ChallengePageData;
}

export interface BuildPreviousChallengePageInput {
  readonly definition: SeasonDefinition;
  readonly generationId: string;
  readonly stylesheetPath: string;
  readonly generatedAt: string;
  readonly leaderboard: Leaderboard;
  readonly previousGenerationPath: string;
  readonly presentation: GalleryPresentation;
}

export interface PreviousChallengePage extends ChallengePage {
  readonly screenshotSources: readonly {
    readonly sourcePath: string;
    readonly destinationPath: string;
  }[];
}

export async function loadSeasonDefinition(
  rootPath: string,
): Promise<SeasonDefinition> {
  const absoluteRoot = resolve(rootPath);
  const config = await readYamlWithSchema(
    join(absoluteRoot, "challenge.yaml"),
    ChallengeConfigSchema,
  );
  const [template, starterCss, fallbackCss, seed] = await Promise.all([
    readFile(join(absoluteRoot, config.template), "utf8"),
    readFile(join(absoluteRoot, config.starterCss), "utf8"),
    readFile(join(absoluteRoot, config.fallbackCss), "utf8"),
    readJsonWithSchema(join(absoluteRoot, config.seedData), SeedGenerationSchema),
  ]);

  if (seed.seasonId !== config.seasonId) {
    throw new Error("seed data seasonId does not match challenge configuration");
  }

  return {
    rootPath: absoluteRoot,
    config,
    template,
    starterCss,
    fallbackCss,
    seed,
    staticCopy: STATIC_COPY,
  };
}

export function buildArchivedSeasonDefinition(input: {
  readonly rootPath: string;
  readonly archive: GallerySourceArchive;
  readonly starterCss: string;
  readonly fallbackCss: string;
}): SeasonDefinition {
  const archive = GallerySourceArchiveSchema.parse(input.archive);
  return {
    rootPath: resolve(input.rootPath),
    config: archive.challengeConfig,
    template: archive.template,
    starterCss: input.starterCss,
    fallbackCss: input.fallbackCss,
    seed: archive.seed,
    staticCopy: archive.staticCopy,
  };
}

function pageEntryFromSeed(entry: SeedEntry, staticCopy: GalleryStaticCopy): PageEntry {
  return {
    id: entry.id,
    rank: null,
    displayName: staticCopy.seedEntry.displayName,
    harnessName: staticCopy.seedEntry.harnessName,
    modelName: staticCopy.seedEntry.modelName,
    status: "seed",
    statusLabel: staticCopy.seedEntry.statusLabel,
    alt: entry.alt,
    screenshotPath: entry.screenshotPath,
    combinedScoreLabel: "—",
    originalityScoreLabel: "—",
    completedJudgeCount: 0,
    expectedJudgeCount: 0,
    runtimeLabel: "—",
    estimatedCostLabel: "—",
    dimensionMeanLabels: null,
    judgeScores: [],
    awards: [],
    failure: null,
  };
}

function scoreLabel(score: number | null | undefined): string {
  return score === null || score === undefined ? "—" : score.toFixed(2);
}

export function formatDimensionMeanLabels(
  dimensionMeans:
    | NonNullable<Leaderboard["entries"][number]["dimensionMeans"]>
    | null
    | undefined,
): DimensionMeanLabels | null {
  if (dimensionMeans === null || dimensionMeans === undefined) return null;
  return {
    hierarchyAndReadability: scoreLabel(dimensionMeans.hierarchyAndReadability),
    composition: scoreLabel(dimensionMeans.composition),
    typography: scoreLabel(dimensionMeans.typography),
    colourAndVisualSystem: scoreLabel(dimensionMeans.colourAndVisualSystem),
    coherenceAndCraft: scoreLabel(dimensionMeans.coherenceAndCraft),
    originalityAndMemorability: scoreLabel(dimensionMeans.originalityAndMemorability),
    constraintAndCssCraft: scoreLabel(dimensionMeans.constraintAndCssCraft),
  };
}

function statusLabel(
  status: PageEntry["status"],
  labels: GalleryStaticCopy["statusLabels"],
): string {
  return labels[status];
}

export function publicFailureMessage(status: PageEntry["status"]): string | null {
  switch (status) {
    case "invalid":
      return "This submission did not pass stylesheet validation.";
    case "timeout":
      return "This contestant timed out before producing a usable submission.";
    case "render_failed":
      return "This submission could not be rendered for judging.";
    case "execution_failed":
      return "This contestant did not produce a usable submission.";
    case "judge_incomplete":
      return "Some judge results were unavailable for this contestant.";
    case "valid":
    case "seed":
      return null;
  }
}

function createPageData(
  definition: SeasonDefinition,
  input: Pick<
    BuildChallengePageInput,
    "generationId" | "stylesheetPath" | "generatedAt"
  >,
  entries: readonly PageEntry[],
  judgeMatrix: JudgeMatrix,
  awards: readonly PageAward[],
  badge: string,
): ChallengePageData {
  const pageJudgeMatrix = {
    columns: judgeMatrix.columns.map((column) => ({ ...column })),
    rows: judgeMatrix.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => ({ ...cell })),
    })),
  };
  return ChallengePageDataSchema.parse({
    schemaVersion: 1,
    seasonId: definition.config.seasonId,
    seasonLabel: definition.config.seasonId.slice(1),
    generationId: GenerationIdSchema.parse(input.generationId),
    title: definition.config.title,
    descriptor: definition.staticCopy.descriptor,
    shortDescription: definition.staticCopy.shortDescription,
    statusBadge: badge,
    headline: definition.staticCopy.headline,
    introduction: definition.staticCopy.introduction,
    centralQuestion: definition.staticCopy.centralQuestion,
    rules: [...definition.staticCopy.rules],
    entries,
    judgeMatrix: pageJudgeMatrix,
    awards,
    method: definition.staticCopy.method,
    generationTimestamp: input.generatedAt,
    challengeVersion: definition.config.challengeVersion,
    renderingEnvironmentVersion: `${definition.config.browser.engine} · ${definition.config.viewport.width}×${definition.config.viewport.height} · JavaScript disabled`,
    stylesheetPath: input.stylesheetPath,
  });
}

function renderChallengePage(data: ChallengePageData, template: string): string {
  const render = Handlebars.compile(template, {
    noEscape: false,
    strict: true,
  });
  return render(data);
}

export async function buildChallengePage(
  input: BuildChallengePageInput,
): Promise<ChallengePage> {
  const data = createPageData(
    input.definition,
    input,
    input.entries,
    input.judgeMatrix,
    input.awards,
    input.statusBadge,
  );
  return {
    html: renderChallengePage(data, input.definition.template),
    entries: input.entries,
    data,
  };
}

export async function buildSeedChallengePage(
  input: BuildSeedChallengePageInput,
): Promise<ChallengePage> {
  if (
    !Number.isInteger(input.rosterSize) ||
    input.rosterSize < 2 ||
    input.rosterSize > 6
  ) {
    throw new Error("Season 1 roster must contain between two and six contestants");
  }
  if (!Number.isInteger(input.judgeCount) || input.judgeCount < 1) {
    throw new Error("challenge judge count must be a positive integer");
  }

  const entries = input.definition.seed.entries
    .slice(0, input.rosterSize)
    .map((entry) => pageEntryFromSeed(entry, input.definition.staticCopy));
  const columns = Array.from({ length: input.judgeCount }, (_, index) => ({
    judgeId: null,
    displayName: `Judge ${index + 1}`,
  }));
  const judgeMatrix: JudgeMatrix = {
    columns,
    rows: entries.map((entry, index) => ({
      contestantId: entry.id,
      rowHeader: `${index + 1} · Seed entry`,
      cells: columns.map(() => ({
        judgeId: null,
        state: "placeholder" as const,
        label: "—",
      })),
      combinedScoreLabel: "—",
      scoreRangeLabel: "—",
    })),
  };
  return buildChallengePage({
    definition: input.definition,
    generationId: input.generationId,
    stylesheetPath: input.stylesheetPath,
    generatedAt: input.generatedAt,
    statusBadge: "Seed field · awaiting first run",
    entries,
    judgeMatrix,
    awards: [],
  });
}

export async function buildPreviousChallengePage(
  input: BuildPreviousChallengePageInput,
): Promise<PreviousChallengePage> {
  const screenshotSources: {
    sourcePath: string;
    destinationPath: string;
  }[] = [];
  const entries = input.leaderboard.entries.map((entry, index) => {
    const destinationPath = `thumbnails/previous-${entry.contestantId}.png`;
    const sourcePath =
      entry.screenshotPath === null
        ? join(
            input.definition.rootPath,
            "seed",
            input.definition.seed.entries[index % input.definition.seed.entries.length]!
              .screenshotPath,
          )
        : resolve(input.previousGenerationPath, entry.screenshotPath);
    screenshotSources.push({ sourcePath, destinationPath });
    return {
      id: entry.contestantId,
      rank: entry.rank,
      displayName: entry.displayName,
      harnessName: entry.harnessName,
      modelName: entry.modelName,
      status: entry.status,
      statusLabel: statusLabel(entry.status, input.definition.staticCopy.statusLabels),
      alt: `${entry.displayName} previous-generation screenshot`,
      screenshotPath: destinationPath,
      combinedScoreLabel: scoreLabel(entry.combinedScore),
      originalityScoreLabel: scoreLabel(entry.originalityScore),
      completedJudgeCount: entry.completedJudgeCount,
      expectedJudgeCount: entry.expectedJudgeCount,
      runtimeLabel:
        input.presentation.operationalLabelsByContestant.get(entry.contestantId)
          ?.runtimeLabel ?? "—",
      estimatedCostLabel:
        input.presentation.operationalLabelsByContestant.get(entry.contestantId)
          ?.estimatedCostLabel ?? "—",
      dimensionMeanLabels: formatDimensionMeanLabels(entry.dimensionMeans),
      judgeScores: entry.judgeScores.map((score) => ({
        judgeId: score.judgeId,
        judgeDisplayName:
          input.presentation.judgeDisplayNames.get(score.judgeId) ?? score.judgeId,
        totalScore: score.totalScore,
        originalityScore: score.originalityScore,
        critique: score.critique,
        ...(score.strongestQuality === undefined
          ? {}
          : { strongestQuality: score.strongestQuality }),
        ...(score.primaryWeakness === undefined
          ? {}
          : { primaryWeakness: score.primaryWeakness }),
        ...(score.nextMove === undefined ? {} : { nextMove: score.nextMove }),
        ...(score.scores === undefined ? {} : { scores: score.scores }),
        ...(score.candidateRank === undefined
          ? {}
          : { candidateRank: score.candidateRank }),
      })),
      awards: entry.awards.map((award) => ({ label: award.label })),
      failure: publicFailureMessage(entry.status),
    };
  });
  const awards = input.leaderboard.entries.flatMap((entry) =>
    entry.awards.map((award) => ({
      label: award.label,
      anonymousCandidateId: entry.contestantId,
      winningDisplayName: entry.displayName,
      judgeId: award.judgeId,
      judgeDisplayName:
        input.presentation.judgeDisplayNames.get(award.judgeId) ?? award.judgeId,
      rationale: award.rationale,
    })),
  );
  const page = await buildChallengePage({
    definition: input.definition,
    generationId: input.generationId,
    stylesheetPath: input.stylesheetPath,
    generatedAt: input.generatedAt,
    statusBadge: `Previous generation ${input.leaderboard.generationId} field`,
    entries,
    judgeMatrix: input.presentation.judgeMatrix,
    awards,
  });
  return {
    ...page,
    screenshotSources,
  };
}

export { ChallengePageDataSchema, SeedGenerationSchema } from "./data.js";
