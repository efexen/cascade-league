import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  AnonymousMapSchema,
  JudgesConfigSchema,
  LeaderboardSchema,
  ManifestSchema,
  RunSchema,
  TaskStateSchema,
  readJsonWithSchema,
  readYamlWithSchema,
  type JudgesConfig,
  type Leaderboard,
  type Manifest,
  type TaskState,
} from "../schemas/index.js";

export type JudgeMatrixCellState =
  | "score"
  | "missing"
  | "invalid"
  | "timed_out"
  | "placeholder";

export interface ContestantOperationalLabels {
  readonly runtimeLabel: string;
  readonly estimatedCostLabel: string;
}

export interface JudgeMatrixColumn {
  readonly judgeId: string | null;
  readonly displayName: string;
}

export interface JudgeMatrixCell {
  readonly judgeId: string | null;
  readonly state: JudgeMatrixCellState;
  readonly label: string;
}

export interface JudgeMatrixRow {
  readonly contestantId: string;
  readonly rowHeader: string;
  readonly cells: readonly JudgeMatrixCell[];
  readonly combinedScoreLabel: string;
  readonly scoreRangeLabel: string;
}

export interface JudgeMatrix {
  readonly columns: readonly JudgeMatrixColumn[];
  readonly rows: readonly JudgeMatrixRow[];
}

export interface LoadGalleryPresentationInput {
  readonly generationPath: string;
  readonly manifest: Manifest;
  readonly leaderboard: Leaderboard;
  readonly judgesConfig: JudgesConfig;
}

export interface GalleryPresentation {
  readonly operationalLabelsByContestant: ReadonlyMap<
    string,
    ContestantOperationalLabels
  >;
  readonly judgeDisplayNames: ReadonlyMap<string, string>;
  readonly judgeMatrix: JudgeMatrix;
  /** Generation-relative private files consumed for this public projection. */
  readonly sourceFiles: readonly string[];
}

const MISSING_LABEL = "Missing";
const INVALID_LABEL = "Invalid";
const TIMED_OUT_LABEL = "Timed out";

function generationPathFor(generationPath: string, relativePath: string): string {
  return join(generationPath, ...relativePath.split("/"));
}

async function assertRegularFile(
  generationPath: string,
  relativePath: string,
  description: string,
): Promise<void> {
  if (
    relativePath.startsWith("/") ||
    relativePath
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${description} has an unsafe relative path`);
  }
  let currentPath = generationPath;
  const segments = relativePath.split("/");
  const generationStatus = await lstat(currentPath);
  if (generationStatus.isSymbolicLink() || !generationStatus.isDirectory()) {
    throw new Error("generation path must be a regular directory");
  }
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    const status = await lstat(currentPath);
    if (status.isSymbolicLink()) {
      throw new Error(`${description} must not use a symbolic link`);
    }
    if (index === segments.length - 1) {
      if (!status.isFile()) throw new Error(`${description} must be a regular file`);
    } else if (!status.isDirectory()) {
      throw new Error(`${description} parent must be a regular directory`);
    }
  }
}

async function readRequiredJson<T>(
  generationPath: string,
  relativePath: string,
  schema: Parameters<typeof readJsonWithSchema>[1],
  description: string,
): Promise<T> {
  const path = generationPathFor(generationPath, relativePath);
  await assertRegularFile(generationPath, relativePath, description);
  return readJsonWithSchema(path, schema) as Promise<T>;
}

function twoDecimalLabel(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

function runtimeLabel(durationMs: number | null): string {
  return durationMs === null ? "—" : `${(durationMs / 1000).toFixed(2)} s`;
}

function estimatedCostLabel(estimatedCostUsd: number | null): string {
  return estimatedCostUsd === null ? "—" : `USD ${estimatedCostUsd.toFixed(6)}`;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

const DIMENSION_KEYS = [
  "hierarchyAndReadability",
  "composition",
  "typography",
  "colourAndVisualSystem",
  "coherenceAndCraft",
  "originalityAndMemorability",
  "constraintAndCssCraft",
] as const;

type LeaderboardEntry = Leaderboard["entries"][number];

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function compareAscending(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDescending(left: number, right: number): number {
  return left > right ? -1 : left < right ? 1 : 0;
}

function populationStandardDeviation(
  values: readonly number[],
  average: number,
): number {
  if (values.length === 0) return 0;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length,
  );
}

function assertRequiredAggregate(
  entry: LeaderboardEntry,
  field: string,
  actual: number | null,
  expected: number | null,
): void {
  if (
    (expected === null && actual !== null) ||
    (expected !== null && (actual === null || !closeEnough(actual, expected)))
  ) {
    throw new Error(
      `leaderboard ${field} contradicts judge-score evidence for ${entry.contestantId}`,
    );
  }
}

function assertOptionalAggregate(
  entry: LeaderboardEntry,
  field: string,
  actual: number | null | undefined,
  expected: number | null,
): void {
  if (actual === undefined) return;
  if (
    (expected === null && actual !== null) ||
    (expected !== null && (actual === null || !closeEnough(actual, expected)))
  ) {
    throw new Error(
      `leaderboard ${field} contradicts judge-score evidence for ${entry.contestantId}`,
    );
  }
}

function validateDimensionEvidence(entry: LeaderboardEntry): void {
  const scoresWithDimensions = entry.judgeScores.filter(
    (score) => score.scores !== undefined,
  );
  for (const score of scoresWithDimensions) {
    const dimensions = score.scores!;
    const dimensionTotal = DIMENSION_KEYS.reduce(
      (total, key) => total + dimensions[key],
      0,
    );
    if (!closeEnough(score.totalScore, dimensionTotal)) {
      throw new Error(
        `leaderboard judge total contradicts dimension scores for ${entry.contestantId}`,
      );
    }
    if (!closeEnough(score.originalityScore, dimensions.originalityAndMemorability)) {
      throw new Error(
        `leaderboard judge originality contradicts dimension scores for ${entry.contestantId}`,
      );
    }
  }

  if (
    entry.meanHierarchyAndReadability !== undefined &&
    entry.meanHierarchyAndReadability !== null &&
    entry.dimensionMeans !== undefined &&
    entry.dimensionMeans !== null &&
    !closeEnough(
      entry.meanHierarchyAndReadability,
      entry.dimensionMeans.hierarchyAndReadability,
    )
  ) {
    throw new Error(
      `leaderboard hierarchy aggregates contradict each other for ${entry.contestantId}`,
    );
  }

  if (scoresWithDimensions.length !== entry.judgeScores.length) return;
  for (const key of DIMENSION_KEYS) {
    const expected = mean(scoresWithDimensions.map((score) => score.scores![key]));
    if (entry.dimensionMeans !== undefined) {
      const actual = entry.dimensionMeans === null ? null : entry.dimensionMeans[key];
      assertOptionalAggregate(entry, `dimensionMeans.${key}`, actual, expected);
    }
    if (key === "hierarchyAndReadability") {
      assertOptionalAggregate(
        entry,
        "meanHierarchyAndReadability",
        entry.meanHierarchyAndReadability,
        expected,
      );
    }
  }
}

function hierarchyEvidence(entry: LeaderboardEntry): number | null {
  if (
    entry.judgeScores.length > 0 &&
    entry.judgeScores.every((score) => score.scores !== undefined)
  ) {
    return mean(
      entry.judgeScores.map((score) => score.scores!.hierarchyAndReadability),
    );
  }
  if (
    entry.meanHierarchyAndReadability !== undefined &&
    entry.meanHierarchyAndReadability !== null
  ) {
    return entry.meanHierarchyAndReadability;
  }
  if (entry.dimensionMeans !== undefined && entry.dimensionMeans !== null) {
    return entry.dimensionMeans.hierarchyAndReadability;
  }
  return null;
}

/**
 * Validates the score evidence already present in a leaderboard. This function
 * deliberately never sorts or rewrites entries: the caller must provide the
 * official rendered order and this function only audits it.
 */
export function validateLeaderboardIntegrity(leaderboard: Leaderboard): void {
  validateLeaderboardOrdering(leaderboard);
  for (const entry of leaderboard.entries) {
    if (entry.expectedJudgeCount !== leaderboard.expectedJudgeCount) {
      throw new Error(
        `leaderboard judge count does not match the generation for ${entry.contestantId}`,
      );
    }
    if (entry.completedJudgeCount !== entry.judgeScores.length) {
      throw new Error(
        `leaderboard judge score count does not match completed count for ${entry.contestantId}`,
      );
    }

    const totals = entry.judgeScores.map((score) => score.totalScore);
    const originalityScores = entry.judgeScores.map((score) => score.originalityScore);
    const combinedScore = mean(totals);
    const medianScore = median(totals);
    const originalityScore = mean(originalityScores);
    const minimumScore = totals.length === 0 ? null : Math.min(...totals);
    const maximumScore = totals.length === 0 ? null : Math.max(...totals);
    const scoreRange =
      minimumScore === null || maximumScore === null
        ? null
        : maximumScore - minimumScore;
    const standardDeviation =
      combinedScore === null
        ? null
        : populationStandardDeviation(totals, combinedScore);

    assertRequiredAggregate(entry, "combinedScore", entry.combinedScore, combinedScore);
    assertRequiredAggregate(entry, "medianScore", entry.medianScore, medianScore);
    assertRequiredAggregate(
      entry,
      "originalityScore",
      entry.originalityScore,
      originalityScore,
    );
    assertOptionalAggregate(entry, "minimumScore", entry.minimumScore, minimumScore);
    assertOptionalAggregate(entry, "maximumScore", entry.maximumScore, maximumScore);
    assertOptionalAggregate(entry, "scoreRange", entry.scoreRange, scoreRange);
    assertOptionalAggregate(
      entry,
      "standardDeviation",
      entry.standardDeviation,
      standardDeviation,
    );
    if (totals.length === 0) {
      if (
        (entry.dimensionMeans !== undefined && entry.dimensionMeans !== null) ||
        (entry.meanHierarchyAndReadability !== undefined &&
          entry.meanHierarchyAndReadability !== null)
      ) {
        throw new Error(
          `leaderboard dimension evidence has no judge scores for ${entry.contestantId}`,
        );
      }
    }
    validateDimensionEvidence(entry);
  }

  validateLeaderboardRankEligibility(leaderboard);
  let previousRanked: LeaderboardEntry | null = null;
  for (const entry of leaderboard.entries) {
    if (entry.rank === null) continue;
    if (previousRanked !== null) {
      const combined = compareDescending(
        previousRanked.combinedScore!,
        entry.combinedScore!,
      );
      const medianDifference = compareDescending(
        previousRanked.medianScore!,
        entry.medianScore!,
      );
      const originality = compareDescending(
        previousRanked.originalityScore!,
        entry.originalityScore!,
      );
      const previousHierarchy = hierarchyEvidence(previousRanked);
      const currentHierarchy = hierarchyEvidence(entry);
      const hierarchy =
        previousHierarchy === null || currentHierarchy === null
          ? 0
          : compareDescending(previousHierarchy, currentHierarchy);
      const contestantId = compareAscending(
        previousRanked.contestantId,
        entry.contestantId,
      );
      const comparison =
        combined || medianDifference || originality || hierarchy || contestantId;
      if (comparison > 0) {
        throw new Error(
          "leaderboard ranked entries do not follow the official comparator",
        );
      }
    }
    previousRanked = entry;
  }
}

function validateJudgeRoster(
  manifest: Manifest,
  judgesConfig: JudgesConfig,
): Map<string, string> {
  const enabledJudges = judgesConfig.judges.filter((judge) => judge.enabled);
  const enabledJudgeIds = enabledJudges.map((judge) => judge.id);
  if (!sameValues(enabledJudgeIds, manifest.judgeIds)) {
    throw new Error(
      "enabled copied judge roster does not match the generation manifest",
    );
  }
  return new Map(enabledJudges.map((judge) => [judge.id, judge.displayName]));
}

function validateLeaderboardJudgeScores(
  manifest: Manifest,
  leaderboard: Leaderboard,
): void {
  for (const entry of leaderboard.entries) {
    const seen = new Set<string>();
    for (const score of entry.judgeScores) {
      if (!manifest.judgeIds.includes(score.judgeId)) {
        throw new Error(`leaderboard contains an unknown judge: ${score.judgeId}`);
      }
      if (seen.has(score.judgeId)) {
        throw new Error(
          `leaderboard contains duplicate judge scores for ${entry.contestantId}`,
        );
      }
      seen.add(score.judgeId);
    }
  }
}

function validateLeaderboardOrdering(leaderboard: Leaderboard): void {
  let previousRank = 0;
  let sawUnrankedEntry = false;
  for (const entry of leaderboard.entries) {
    if (entry.rank === null) {
      sawUnrankedEntry = true;
      continue;
    }
    if (sawUnrankedEntry) {
      throw new Error(
        "leaderboard ordering is malformed: ranked entries must precede unranked entries",
      );
    }
    if (entry.rank !== previousRank + 1) {
      throw new Error(
        "leaderboard ordering is malformed: ranked entries must remain in rank order",
      );
    }
    previousRank = entry.rank;
  }
}

function hasRankableScoreEvidence(entry: Leaderboard["entries"][number]): boolean {
  return (
    (entry.status === "valid" || entry.status === "judge_incomplete") &&
    entry.judgeScores.length > 0 &&
    entry.completedJudgeCount === entry.judgeScores.length &&
    entry.combinedScore !== null &&
    entry.medianScore !== null &&
    entry.originalityScore !== null
  );
}

function validateLeaderboardRankEligibility(leaderboard: Leaderboard): void {
  for (const entry of leaderboard.entries) {
    const hasScoreEvidence = hasRankableScoreEvidence(entry);
    if (
      entry.judgeScores.length > 0 &&
      entry.status !== "valid" &&
      entry.status !== "judge_incomplete"
    ) {
      throw new Error(
        `failed leaderboard entry contains judge score evidence: ${entry.contestantId}`,
      );
    }
    if (entry.rank === null && entry.judgeScores.length > 0) {
      throw new Error(
        `leaderboard entry with judge score evidence cannot be unranked: ${entry.contestantId}`,
      );
    }
    if (entry.rank === null && hasScoreEvidence) {
      throw new Error(
        `leaderboard entry with rankable score evidence cannot be unranked: ${entry.contestantId}`,
      );
    }
    if (entry.rank !== null && !hasScoreEvidence) {
      throw new Error(
        `ranked leaderboard entry lacks rankable score evidence: ${entry.contestantId}`,
      );
    }
  }
}

async function readAndValidateAnonymousMap(
  generationPath: string,
  manifest: Manifest,
): Promise<{
  readonly byContestantId: ReadonlyMap<string, string>;
  readonly sourceFile: string;
}> {
  const relativePath = "judging/anonymous-map.json";
  const map = await readRequiredJson<ReturnType<typeof AnonymousMapSchema.parse>>(
    generationPath,
    relativePath,
    AnonymousMapSchema,
    "anonymous map",
  );
  if (map.generationId !== manifest.generationId) {
    throw new Error("anonymous map generation ID does not match the manifest");
  }
  const contestantIds = map.entries.map((entry) => entry.contestantId);
  if (
    !sameValues([...new Set(contestantIds)].sort(), [...manifest.contestantIds].sort())
  ) {
    throw new Error("anonymous map contestant set does not match the manifest");
  }
  return {
    byContestantId: new Map(
      map.entries.map((entry) => [entry.contestantId, entry.anonymousCandidateId]),
    ),
    sourceFile: relativePath,
  };
}

async function readTaskIfPresent(
  generationPath: string,
  relativePath: string,
): Promise<TaskState | null> {
  const path = generationPathFor(generationPath, relativePath);
  try {
    await assertRegularFile(generationPath, relativePath, "judge task state");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return TaskStateSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function validateJudgeTask(
  task: TaskState,
  manifest: Manifest,
  judgeId: string,
  anonymousCandidateId: string,
): void {
  const expectedTaskId = `${manifest.generationId}-judge-${judgeId}-${anonymousCandidateId}`;
  const expectedTargetId = `${judgeId}\0${anonymousCandidateId}`;
  if (task.role !== "judge") {
    throw new Error(`judge task has an unexpected role for ${judgeId}`);
  }
  if (task.taskId !== expectedTaskId) {
    throw new Error(`judge task ID does not match its expected candidate`);
  }
  if (task.targetId !== expectedTargetId) {
    throw new Error(`judge task target ID does not match its expected candidate`);
  }
}

function matrixCell(
  judgeId: string,
  totalScore: number | null,
  task: TaskState | null,
): JudgeMatrixCell {
  // Upstream leaderboard validation owns score validity. When it supplies a
  // valid score, preserve that score even if a durable task state is invalid
  // or timed out; task status classifies only a cell with no valid score.
  if (totalScore !== null) {
    return { judgeId, state: "score", label: String(totalScore) };
  }
  if (task?.status === "invalid") {
    return { judgeId, state: "invalid", label: INVALID_LABEL };
  }
  if (task?.status === "timeout") {
    return { judgeId, state: "timed_out", label: TIMED_OUT_LABEL };
  }
  return { judgeId, state: "missing", label: MISSING_LABEL };
}

export async function loadGalleryPresentation(
  input: LoadGalleryPresentationInput,
): Promise<GalleryPresentation> {
  const generationPath = input.generationPath;
  const manifest = ManifestSchema.parse(input.manifest);
  const leaderboard = LeaderboardSchema.parse(input.leaderboard);
  const judgesConfig = JudgesConfigSchema.parse(input.judgesConfig);

  if (
    leaderboard.seasonId !== manifest.seasonId ||
    leaderboard.generationId !== manifest.generationId
  ) {
    throw new Error("leaderboard does not match the generation manifest");
  }
  if (leaderboard.entries.length !== manifest.contestantIds.length) {
    throw new Error("leaderboard contestant set does not match the manifest");
  }
  const leaderboardContestantIds = leaderboard.entries.map(
    (entry) => entry.contestantId,
  );
  if (
    !sameValues(
      [...new Set(leaderboardContestantIds)].sort(),
      [...manifest.contestantIds].sort(),
    )
  ) {
    throw new Error("leaderboard contestant set does not match the manifest");
  }
  validateLeaderboardJudgeScores(manifest, leaderboard);
  validateLeaderboardIntegrity(leaderboard);

  const judgeDisplayNames = validateJudgeRoster(manifest, judgesConfig);
  const judgeConfigRelativePath = "config/judges.yaml";
  const judgeConfigPath = generationPathFor(generationPath, judgeConfigRelativePath);
  await assertRegularFile(
    generationPath,
    judgeConfigRelativePath,
    "copied judges configuration",
  );
  const copiedJudgesConfig = await readYamlWithSchema(
    judgeConfigPath,
    JudgesConfigSchema,
  );
  if (!isDeepStrictEqual(copiedJudgesConfig, judgesConfig)) {
    throw new Error("copied judges configuration does not match the supplied config");
  }

  const anonymousMap = await readAndValidateAnonymousMap(generationPath, manifest);
  const sourceFiles: string[] = [judgeConfigRelativePath, anonymousMap.sourceFile];
  const operationalLabelsByContestant = new Map<string, ContestantOperationalLabels>();

  for (const contestantId of manifest.contestantIds) {
    const runRelativePath = `contestants/${contestantId}/run.json`;
    const run = await readRequiredJson<ReturnType<typeof RunSchema.parse>>(
      generationPath,
      runRelativePath,
      RunSchema,
      `run for ${contestantId}`,
    );
    const anonymousCandidateId = anonymousMap.byContestantId.get(contestantId);
    if (anonymousCandidateId === undefined) {
      throw new Error(`anonymous map is missing contestant ${contestantId}`);
    }
    const expectedTaskId = `${manifest.generationId}-contestant-${anonymousCandidateId}`;
    if (run.taskId !== expectedTaskId) {
      throw new Error(`contestant run task ID does not match ${contestantId}`);
    }
    sourceFiles.push(runRelativePath);
    operationalLabelsByContestant.set(contestantId, {
      runtimeLabel: runtimeLabel(run.durationMs),
      estimatedCostLabel: estimatedCostLabel(run.usage.estimatedCostUsd),
    });
  }

  const taskByJudgeAndCandidate = new Map<string, TaskState>();
  for (const judgeId of manifest.judgeIds) {
    for (const contestantId of manifest.contestantIds) {
      const anonymousCandidateId = anonymousMap.byContestantId.get(contestantId);
      if (anonymousCandidateId === undefined) {
        throw new Error(`anonymous map is missing contestant ${contestantId}`);
      }
      const taskRelativePath = `judging/${judgeId}/tasks/${anonymousCandidateId}.json`;
      const task = await readTaskIfPresent(generationPath, taskRelativePath);
      if (task === null) continue;
      validateJudgeTask(task, manifest, judgeId, anonymousCandidateId);
      taskByJudgeAndCandidate.set(`${judgeId}\0${contestantId}`, task);
      sourceFiles.push(taskRelativePath);
    }
  }

  const rows = leaderboard.entries.map((entry) => {
    const anonymousCandidateId = anonymousMap.byContestantId.get(entry.contestantId);
    if (anonymousCandidateId === undefined) {
      throw new Error(`anonymous map is missing contestant ${entry.contestantId}`);
    }
    const cells = manifest.judgeIds.map((judgeId) => {
      const score = entry.judgeScores.find(
        (candidate) => candidate.judgeId === judgeId,
      );
      return matrixCell(
        judgeId,
        score === undefined ? null : score.totalScore,
        taskByJudgeAndCandidate.get(`${judgeId}\0${entry.contestantId}`) ?? null,
      );
    });
    return {
      contestantId: entry.contestantId,
      rowHeader:
        entry.rank === null
          ? `Unranked · ${entry.displayName}`
          : `${entry.rank} · ${entry.displayName}`,
      cells,
      combinedScoreLabel: twoDecimalLabel(entry.combinedScore),
      scoreRangeLabel: twoDecimalLabel(entry.scoreRange),
    } satisfies JudgeMatrixRow;
  });

  return {
    operationalLabelsByContestant,
    judgeDisplayNames,
    judgeMatrix: {
      columns: manifest.judgeIds.map((judgeId) => ({
        judgeId,
        displayName: judgeDisplayNames.get(judgeId)!,
      })),
      rows,
    },
    sourceFiles,
  };
}
