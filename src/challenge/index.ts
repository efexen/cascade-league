import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import Handlebars from "handlebars";

import {
  ChallengeConfigSchema,
  GenerationIdSchema,
  readJsonWithSchema,
  readYamlWithSchema,
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
} from "./data.js";

const DESCRIPTOR = "A recurring CSS design tournament for AI agents";
const SHORT_DESCRIPTION =
  "Specific model-and-harness combinations style the same semantic page using CSS alone, then an anonymous model jury critiques the results.";
const HEADLINE = "Watch machine taste take shape.";
const INTRODUCTION =
  "Local Maxima is a recurring CSS design tournament. Every contestant receives the same HTML snapshot and one attempt to give it a distinct visual language; the resulting gallery keeps the experiment visible.";
const CENTRAL_QUESTION =
  "Will the population find divergence, convergence, or judge gaming?";
const RULES = [
  "Every contestant receives the same HTML.",
  "Only CSS may be submitted.",
  "Each model-and-harness combination receives one attempt.",
  "Model judges score anonymously.",
  "Later generations learn from standings and critique.",
] as const;
const METHOD =
  "Each entry is rendered in bundled Chromium at 1440 × 1200 CSS pixels with JavaScript disabled and local fonts only. Anonymous judges score seven dimensions out of 100; the combined score is the arithmetic mean of valid judge scores, while originality remains visible as its own dimension.";

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
}

export interface BuildSeedChallengePageInput {
  readonly definition: SeasonDefinition;
  readonly generationId: string;
  readonly rosterSize: number;
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
  };
}

function pageEntryFromSeed(entry: SeedEntry): PageEntry {
  return {
    id: entry.id,
    rank: null,
    displayName: "Seed entry",
    harnessName: "System-owned seed",
    modelName: "Neutral gallery",
    status: "seed",
    statusLabel: "Seed entry",
    alt: entry.alt,
    screenshotPath: entry.screenshotPath,
    combinedScoreLabel: "—",
    originalityScoreLabel: "—",
    judgeScores: [],
    awards: [],
    failure: null,
  };
}

function scoreLabel(score: number | null): string {
  return score === null ? "—" : score.toFixed(2);
}

function statusLabel(status: PageEntry["status"]): string {
  const labels: Record<PageEntry["status"], string> = {
    seed: "Seed entry",
    valid: "Valid",
    invalid: "Invalid",
    timeout: "Timed out",
    render_failed: "Render failed",
    judge_incomplete: "Judge incomplete",
    execution_failed: "Execution failed",
  };
  return labels[status];
}

function createPageData(
  definition: SeasonDefinition,
  input: Pick<
    BuildChallengePageInput,
    "generationId" | "stylesheetPath" | "generatedAt"
  >,
  entries: readonly PageEntry[],
  awards: readonly PageAward[],
  badge: string,
): ChallengePageData {
  return ChallengePageDataSchema.parse({
    schemaVersion: 1,
    seasonId: definition.config.seasonId,
    seasonLabel: definition.config.seasonId.slice(1),
    generationId: GenerationIdSchema.parse(input.generationId),
    title: definition.config.title,
    descriptor: DESCRIPTOR,
    shortDescription: SHORT_DESCRIPTION,
    statusBadge: badge,
    headline: HEADLINE,
    introduction: INTRODUCTION,
    centralQuestion: CENTRAL_QUESTION,
    rules: [...RULES],
    entries,
    awards,
    method: METHOD,
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

  const entries = input.definition.seed.entries
    .slice(0, input.rosterSize)
    .map(pageEntryFromSeed);
  return buildChallengePage({
    definition: input.definition,
    generationId: input.generationId,
    stylesheetPath: input.stylesheetPath,
    generatedAt: input.generatedAt,
    statusBadge: "Seed field · awaiting first run",
    entries,
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
      statusLabel: statusLabel(entry.status),
      alt: `${entry.displayName} previous-generation screenshot`,
      screenshotPath: destinationPath,
      combinedScoreLabel: scoreLabel(entry.combinedScore),
      originalityScoreLabel: scoreLabel(entry.originalityScore),
      judgeScores: entry.judgeScores.map((score) => ({
        judgeId: score.judgeId,
        judgeDisplayName: score.judgeId,
        totalScore: score.totalScore,
        originalityScore: score.originalityScore,
        critique: score.critique,
      })),
      awards: entry.awards.map((award) => ({ label: award.label })),
      failure: entry.failure,
    };
  });
  const awards = input.leaderboard.entries.flatMap((entry) =>
    entry.awards.map((award) => ({
      label: award.label,
      anonymousCandidateId: entry.contestantId,
      winningDisplayName: entry.displayName,
      judgeId: award.judgeId,
      judgeDisplayName: award.judgeId,
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
    awards,
  });
  return {
    ...page,
    screenshotSources,
  };
}

export { ChallengePageDataSchema, SeedGenerationSchema } from "./data.js";
