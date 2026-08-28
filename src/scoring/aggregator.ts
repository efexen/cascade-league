import {
  AnonymousCandidateIdSchema,
  CandidateJudgmentSchema,
  ContestantIdSchema,
  GenerationAwardsSchema,
  GenerationIdSchema,
  JudgeIdSchema,
  LeaderboardDimensionMeansSchema,
  LeaderboardSchema,
  SeasonIdSchema,
  UtcTimestampSchema,
  type CandidateJudgment,
  type GenerationAwards,
  type JudgmentScores,
  type Leaderboard,
} from "../schemas/index.js";

const SCORE_KEYS = [
  "hierarchyAndReadability",
  "composition",
  "typography",
  "colourAndVisualSystem",
  "coherenceAndCraft",
  "originalityAndMemorability",
  "constraintAndCssCraft",
] as const satisfies readonly (keyof JudgmentScores)[];

export type ScoreCandidateStatus =
  | "valid"
  | "invalid"
  | "timeout"
  | "render_failed"
  | "judge_incomplete"
  | "execution_failed";

export interface ScoreCandidateInput {
  readonly contestantId: string;
  readonly anonymousCandidateId: string;
  readonly displayName: string;
  readonly harnessName: string;
  readonly modelName: string;
  readonly provider?: string | null;
  readonly modelFamily?: string | null;
  readonly status: ScoreCandidateStatus;
  readonly screenshotPath: string | null;
  readonly failure: string | null;
}

export interface ScoreJudgeInput {
  readonly id: string;
  readonly provider?: string | null;
  readonly modelFamily?: string | null;
}

/**
 * A judgment item is normally a parsed CandidateJudgment. The wrapper form is
 * accepted for callers that retain source-path provenance beside the parsed
 * local artifact.
 */
export type ScoreJudgmentInput =
  | CandidateJudgment
  | { readonly judgment: unknown; readonly sourcePath?: string }
  | unknown;

export type ScoreAwardsInput =
  | GenerationAwards
  | { readonly awards: unknown; readonly sourcePath?: string }
  | unknown;

export interface ScoreAggregatorInput {
  readonly seasonId: string;
  readonly generationId: string;
  readonly generatedAt: string;
  readonly expectedJudgeCount: number;
  readonly judges?: readonly ScoreJudgeInput[];
  readonly candidates: readonly ScoreCandidateInput[];
  readonly judgments: readonly ScoreJudgmentInput[];
  readonly awards?: readonly ScoreAwardsInput[];
}

interface AcceptedJudgment {
  readonly value: CandidateJudgment;
  readonly totalScore: number;
  readonly sameProvider: boolean | null;
  readonly sameModelFamily: boolean | null;
}

interface CandidateRecord {
  readonly input: ScoreCandidateInput;
  readonly judgments: AcceptedJudgment[];
}

function finiteNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function unwrapArtifact(value: unknown, key: "judgment" | "awards"): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return value;
  if (key === "awards" && "schemaVersion" in value) return value;
  return (value as Record<string, unknown>)[key];
}

function totalFromDimensions(scores: JudgmentScores): number {
  return SCORE_KEYS.reduce((total, key) => total + scores[key], 0);
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

function populationStandardDeviation(
  values: readonly number[],
  average: number,
): number {
  if (values.length === 0) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function compareAscending(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDescending(left: number, right: number): number {
  return left > right ? -1 : left < right ? 1 : 0;
}

function compareRankable(left: CandidateRecord, right: CandidateRecord): number {
  const leftTotals = left.judgments.map((judgment) => judgment.totalScore);
  const rightTotals = right.judgments.map((judgment) => judgment.totalScore);
  const leftCombined = mean(leftTotals)!;
  const rightCombined = mean(rightTotals)!;
  const combined = compareDescending(leftCombined, rightCombined);
  if (combined !== 0) return combined;

  const medianDifference = compareDescending(median(leftTotals)!, median(rightTotals)!);
  if (medianDifference !== 0) return medianDifference;

  const leftOriginality = mean(
    left.judgments.map((judgment) => judgment.value.scores.originalityAndMemorability),
  )!;
  const rightOriginality = mean(
    right.judgments.map((judgment) => judgment.value.scores.originalityAndMemorability),
  )!;
  const originality = compareDescending(leftOriginality, rightOriginality);
  if (originality !== 0) return originality;

  const leftHierarchy = mean(
    left.judgments.map((judgment) => judgment.value.scores.hierarchyAndReadability),
  )!;
  const rightHierarchy = mean(
    right.judgments.map((judgment) => judgment.value.scores.hierarchyAndReadability),
  )!;
  const hierarchy = compareDescending(leftHierarchy, rightHierarchy);
  if (hierarchy !== 0) return hierarchy;

  return compareAscending(left.input.contestantId, right.input.contestantId);
}

function statusIsVisuallyValid(status: ScoreCandidateStatus): boolean {
  return status === "valid" || status === "judge_incomplete";
}

function metadataMatch(
  candidateValue: string | null | undefined,
  judgeValue: string | null | undefined,
): boolean | null {
  if (candidateValue === undefined || candidateValue === null) return null;
  if (judgeValue === undefined || judgeValue === null) return null;
  return candidateValue === judgeValue;
}

function orderJudgeScores(
  records: readonly CandidateRecord[],
  judgeIds: readonly string[],
): Map<string, Map<string, number>> {
  const ranks = new Map<string, Map<string, number>>();
  for (const judgeId of [...judgeIds].sort(compareAscending)) {
    const judged = records
      .filter((record) =>
        record.judgments.some((judgment) => judgment.value.judgeId === judgeId),
      )
      .map((record) => {
        const judgment = record.judgments.find(
          (candidateJudgment) => candidateJudgment.value.judgeId === judgeId,
        )!;
        return { record, total: judgment.totalScore };
      })
      .sort((left, right) => {
        const total = compareDescending(left.total, right.total);
        return total === 0
          ? compareAscending(
              left.record.input.contestantId,
              right.record.input.contestantId,
            )
          : total;
      });
    const judgeRanks = new Map<string, number>();
    judged.forEach((entry, index) => {
      judgeRanks.set(entry.record.input.anonymousCandidateId, index + 1);
    });
    ranks.set(judgeId, judgeRanks);
  }
  return ranks;
}

function buildDimensionMeans(
  judgments: readonly AcceptedJudgment[],
): JudgmentScores | null {
  if (judgments.length === 0) return null;
  const values = Object.fromEntries(
    SCORE_KEYS.map((key) => [
      key,
      mean(judgments.map((judgment) => judgment.value.scores[key]))!,
    ]),
  );
  return LeaderboardDimensionMeansSchema.parse(values) as JudgmentScores;
}

function publicFailure(input: ScoreCandidateInput): string | null {
  return input.failure === null || input.failure.trim() === ""
    ? `candidate status: ${input.status}`
    : input.failure;
}

function validateCandidateIdentity(input: ScoreCandidateInput): void {
  ContestantIdSchema.parse(input.contestantId);
  AnonymousCandidateIdSchema.parse(input.anonymousCandidateId);
  if (input.displayName.trim() === "")
    throw new Error("candidate displayName must not be blank");
  if (input.harnessName.trim() === "")
    throw new Error("candidate harnessName must not be blank");
  if (input.modelName.trim() === "")
    throw new Error("candidate modelName must not be blank");
}

function validateJudgeIdentity(input: ScoreJudgeInput): void {
  JudgeIdSchema.parse(input.id);
}

function awardItems(
  awards: readonly ScoreAwardsInput[],
  candidateIds: ReadonlySet<string>,
  judgeIds: ReadonlySet<string>,
  generationId: string,
): {
  readonly judgeId: string;
  readonly candidateId: string;
  readonly label: string;
  readonly rationale: string;
}[] {
  const result: {
    readonly judgeId: string;
    readonly candidateId: string;
    readonly label: string;
    readonly rationale: string;
  }[] = [];
  for (const item of awards) {
    const parsed = GenerationAwardsSchema.safeParse(unwrapArtifact(item, "awards"));
    if (!parsed.success) continue;
    if (parsed.data.generationId !== generationId) continue;
    if (judgeIds.size > 0 && !judgeIds.has(parsed.data.judgeId)) continue;
    for (const award of parsed.data.awards) {
      if (!candidateIds.has(award.anonymousCandidateId)) continue;
      result.push({
        judgeId: parsed.data.judgeId,
        candidateId: award.anonymousCandidateId,
        label: award.label,
        rationale: award.rationale,
      });
    }
  }
  return result.sort((left, right) => {
    const judge = compareAscending(left.judgeId, right.judgeId);
    if (judge !== 0) return judge;
    const candidate = compareAscending(left.candidateId, right.candidateId);
    if (candidate !== 0) return candidate;
    const label = compareAscending(left.label, right.label);
    return label === 0 ? compareAscending(left.rationale, right.rationale) : label;
  });
}

export function serializeLeaderboard(value: Leaderboard): string {
  const validated = LeaderboardSchema.parse(value);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export class ScoreAggregator {
  public aggregate(input: ScoreAggregatorInput): Leaderboard {
    SeasonIdSchema.parse(input.seasonId);
    GenerationIdSchema.parse(input.generationId);
    UtcTimestampSchema.parse(input.generatedAt);
    finiteNonNegativeInteger(input.expectedJudgeCount, "expectedJudgeCount");

    const candidateIds = new Set<string>();
    const contestantIds = new Set<string>();
    const records: CandidateRecord[] = input.candidates.map((candidate) => {
      validateCandidateIdentity(candidate);
      if (candidateIds.has(candidate.anonymousCandidateId)) {
        throw new Error(
          `duplicate anonymous candidate ID: ${candidate.anonymousCandidateId}`,
        );
      }
      if (contestantIds.has(candidate.contestantId)) {
        throw new Error(`duplicate contestant ID: ${candidate.contestantId}`);
      }
      candidateIds.add(candidate.anonymousCandidateId);
      contestantIds.add(candidate.contestantId);
      return { input: candidate, judgments: [] };
    });
    const byCandidate = new Map(
      records.map((record) => [record.input.anonymousCandidateId, record]),
    );

    const judges = input.judges ?? [];
    const judgeMetadata = new Map<string, ScoreJudgeInput>();
    for (const judge of judges) {
      validateJudgeIdentity(judge);
      if (judgeMetadata.has(judge.id))
        throw new Error(`duplicate judge ID: ${judge.id}`);
      judgeMetadata.set(judge.id, judge);
    }
    const knownJudgeIds = new Set(judgeMetadata.keys());
    const seenJudgments = new Set<string>();

    for (const item of input.judgments) {
      const parsed = CandidateJudgmentSchema.safeParse(
        unwrapArtifact(item, "judgment"),
      );
      if (!parsed.success) continue;
      const judgment = parsed.data;
      if (
        judgment.generationId !== input.generationId ||
        !candidateIds.has(judgment.anonymousCandidateId) ||
        (knownJudgeIds.size > 0 && !knownJudgeIds.has(judgment.judgeId))
      ) {
        continue;
      }
      const record = byCandidate.get(judgment.anonymousCandidateId);
      if (record === undefined || !statusIsVisuallyValid(record.input.status)) continue;
      const key = `${judgment.anonymousCandidateId}\0${judgment.judgeId}`;
      if (seenJudgments.has(key)) continue;
      seenJudgments.add(key);
      const totalScore = totalFromDimensions(judgment.scores);
      if (judgment.totalScore !== totalScore) continue;
      const metadata = judgeMetadata.get(judgment.judgeId);
      record.judgments.push({
        value: judgment,
        totalScore,
        sameProvider: metadataMatch(record.input.provider, metadata?.provider),
        sameModelFamily: metadataMatch(record.input.modelFamily, metadata?.modelFamily),
      });
    }

    const inferredJudgeIds = new Set(
      records.flatMap((record) =>
        record.judgments.map((judgment) => judgment.value.judgeId),
      ),
    );
    const allJudgeIds = new Set([...knownJudgeIds, ...inferredJudgeIds]);
    const judgeRanks = orderJudgeScores(records, [...allJudgeIds]);
    const awards = awardItems(
      input.awards ?? [],
      candidateIds,
      allJudgeIds,
      input.generationId,
    );
    const rankable = records
      .filter(
        (record) =>
          statusIsVisuallyValid(record.input.status) &&
          record.input.screenshotPath !== null &&
          record.judgments.length > 0,
      )
      .sort(compareRankable);
    const rankByCandidate = new Map(
      rankable.map((record, index) => [record.input.anonymousCandidateId, index + 1]),
    );
    const rankableIds = new Set(
      rankable.map((record) => record.input.anonymousCandidateId),
    );
    const failed = records
      .filter((record) => !rankableIds.has(record.input.anonymousCandidateId))
      .sort((left, right) => {
        const displayName = compareAscending(
          left.input.displayName,
          right.input.displayName,
        );
        return displayName === 0
          ? compareAscending(left.input.contestantId, right.input.contestantId)
          : displayName;
      });

    const entries = [...rankable, ...failed].map((record) => {
      const candidate = record.input;
      const judgmentValues = record.judgments;
      const totals = judgmentValues.map((judgment) => judgment.totalScore);
      const combinedScore = mean(totals);
      const medianScore = median(totals);
      const originalityScore = mean(
        judgmentValues.map(
          (judgment) => judgment.value.scores.originalityAndMemorability,
        ),
      );
      const hierarchyMean = mean(
        judgmentValues.map((judgment) => judgment.value.scores.hierarchyAndReadability),
      );
      const dimensionMeans = buildDimensionMeans(judgmentValues);
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
      const entryJudgeScores = [...judgmentValues]
        .sort((left, right) =>
          compareAscending(left.value.judgeId, right.value.judgeId),
        )
        .map((judgment) => ({
          judgeId: judgment.value.judgeId,
          totalScore: judgment.totalScore,
          originalityScore: judgment.value.scores.originalityAndMemorability,
          critique: judgment.value.critique,
          strongestQuality: judgment.value.strongestQuality,
          primaryWeakness: judgment.value.primaryWeakness,
          nextMove: judgment.value.nextMove,
          scores: judgment.value.scores,
          candidateRank:
            judgeRanks
              .get(judgment.value.judgeId)
              ?.get(candidate.anonymousCandidateId) ?? null,
          sameProvider: judgment.sameProvider,
          sameModelFamily: judgment.sameModelFamily,
        }));
      const providerComparisons = judgmentValues.filter(
        (judgment) => judgment.sameProvider !== null,
      ).length;
      const modelFamilyComparisons = judgmentValues.filter(
        (judgment) => judgment.sameModelFamily !== null,
      ).length;
      const entryAwards = awards
        .filter(
          (award) =>
            award.candidateId === candidate.anonymousCandidateId &&
            rankableIds.has(candidate.anonymousCandidateId),
        )
        .map((award) => ({
          judgeId: award.judgeId,
          label: award.label,
          rationale: award.rationale,
        }));
      const rank = rankByCandidate.get(candidate.anonymousCandidateId) ?? null;
      const rankableCandidate = rank !== null;
      const status: ScoreCandidateStatus = rankableCandidate
        ? judgmentValues.length < input.expectedJudgeCount
          ? "judge_incomplete"
          : "valid"
        : statusIsVisuallyValid(candidate.status)
          ? "judge_incomplete"
          : candidate.status;
      return {
        rank,
        contestantId: candidate.contestantId,
        displayName: candidate.displayName,
        harnessName: candidate.harnessName,
        modelName: candidate.modelName,
        status,
        screenshotPath: candidate.screenshotPath,
        combinedScore: rankableCandidate ? combinedScore : null,
        medianScore: rankableCandidate ? medianScore : null,
        originalityScore: rankableCandidate ? originalityScore : null,
        meanHierarchyAndReadability: rankableCandidate ? hierarchyMean : null,
        minimumScore: rankableCandidate ? minimumScore : null,
        maximumScore: rankableCandidate ? maximumScore : null,
        scoreRange: rankableCandidate ? scoreRange : null,
        standardDeviation: rankableCandidate ? standardDeviation : null,
        dimensionMeans: rankableCandidate ? dimensionMeans : null,
        completedJudgeCount: judgmentValues.length,
        expectedJudgeCount: input.expectedJudgeCount,
        judgeScores: entryJudgeScores,
        judgeRanks: entryJudgeScores.map((score) => ({
          judgeId: score.judgeId,
          rank: score.candidateRank!,
        })),
        selfFamily: {
          providerMatches: judgmentValues.filter(
            (judgment) => judgment.sameProvider === true,
          ).length,
          providerComparisons,
          modelFamilyMatches: judgmentValues.filter(
            (judgment) => judgment.sameModelFamily === true,
          ).length,
          modelFamilyComparisons,
        },
        awards: entryAwards,
        failure: rankableCandidate ? null : publicFailure(candidate),
      };
    });

    return LeaderboardSchema.parse({
      schemaVersion: 1,
      seasonId: input.seasonId,
      generationId: input.generationId,
      generatedAt: input.generatedAt,
      rankingMethod: "mean-valid-judge-score-v1",
      expectedJudgeCount: input.expectedJudgeCount,
      entries,
    });
  }
}

export function aggregateScores(input: ScoreAggregatorInput): Leaderboard {
  return new ScoreAggregator().aggregate(input);
}
