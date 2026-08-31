import { basename, join, resolve } from "node:path";

import { z } from "zod";

import {
  AnonymousMapSchema,
  CandidateJudgmentSchema,
  ContestantsConfigSchema,
  GenerationAwardsSchema,
  IdentitySchema,
  JudgeTaskTimingsSchema,
  JudgesConfigSchema,
  LeaderboardSchema,
  ManifestSchema,
  RunPlanSchema,
  RunSchema,
  RunSummarySchema,
  TaskStateSchema,
  UtcTimestampSchema,
  readJsonWithSchema,
  readYamlWithSchema,
  type Run,
  type RunSummary,
  type TaskState,
  type TaskRoleCounts,
  type CallVersionCompleteness,
} from "../schemas/index.js";
import {
  readExecutionMetadataFile,
  readUsageFile,
  regularFileExists,
  writeTextAtomically,
} from "../contestants/support.js";

/**
 * Phase 2 §6.8: a pure, deterministic summarizer over the durable artifacts
 * of one generation. It reads only generation-relative durable files (never
 * workspaces, current repository profiles, network sources, or model
 * adapters), rejects identity/generation mismatches, keeps unknown values
 * `null`, distinguishes known zero from unknown, labels known aggregates as
 * partial when any relevant call lacks data, and never copies provider
 * request IDs, prompts, logs, paths, environment names, or raw model data
 * into the summary. It performs no writes; `writeRunSummary` is the separate
 * atomic writer for the next wiring slice.
 */

export const RUN_SUMMARY_FILE_NAME = "run-summary.json";

export interface RunSummaryBuildOptions {
  readonly generationPath: string;
  /**
   * Optional deterministic timestamp. When omitted, the durable manifest
   * completion (or creation) timestamp is used so rebuilding from identical
   * durable artifacts is byte-stable without any supplied input.
   */
  readonly generatedAt?: string;
}

interface NullableUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

const UNKNOWN_USAGE: NullableUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
};

/** One model call that actually happened according to durable evidence. */
interface AttemptedCall {
  /** `false` when the call reports no reasoning field at all. */
  readonly reportsReasoning: boolean;
  readonly reasoningTokens: number | null;
  readonly usage: NullableUsage;
  readonly estimatedCostUsd: number | null;
}

function requireMatch(actual: string, expected: string, description: string): void {
  if (actual !== expected) {
    throw new Error(
      `run summary rejected ${description}: expected "${expected}", found "${actual}"`,
    );
  }
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

async function readOptionalJson<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
): Promise<z.infer<T> | null> {
  if (!(await regularFileExists(path))) return null;
  return readJsonWithSchema(path, schema);
}

function elapsedMsBetween(startedAt: string, completedAt: string): number | null {
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  // The output schema admits only a non-negative known elapsed. A durable
  // manifest whose completion predates its start is inconsistent evidence
  // (clock skew or an injected test clock), so the honest result is unknown
  // (`null`) — never a fabricated negative and never a completion failure.
  return elapsed >= 0 ? elapsed : null;
}

function completenessOf(
  harness: string | null,
  model: string | null,
): CallVersionCompleteness {
  if (harness !== null && model !== null) return "complete";
  if (harness === null && model === null) return "unknown";
  return "partial";
}

function aggregateIntegers(values: readonly (number | null)[]): {
  value: number;
  completeness: "complete" | "partial";
} {
  let total = 0;
  let partial = false;
  for (const value of values) {
    if (value === null) partial = true;
    else total += value;
  }
  return { value: total, completeness: partial ? "partial" : "complete" };
}

function aggregateNumbers(values: readonly (number | null)[]): {
  value: number;
  completeness: "complete" | "partial";
} {
  return aggregateIntegers(values);
}

function usageIsUnknown(usage: NullableUsage): boolean {
  // A call counts as having unknown usage when any of the three token fields
  // every call kind can report is unknown. Reasoning tokens are a
  // contestant-only field and affect only the reasoning aggregate's partial
  // labelling, never these counts.
  return (
    usage.inputTokens === null ||
    usage.outputTokens === null ||
    usage.totalTokens === null
  );
}

interface TaskSlot {
  readonly path: string;
  readonly expectedRole: "contestant" | "render" | "judge" | "awards";
  readonly expectedTargetId: string;
  readonly expectedTaskId: string;
}

async function readTaskSlot(slot: TaskSlot): Promise<TaskState | null> {
  const state = await readOptionalJson(slot.path, TaskStateSchema);
  if (state === null) return null;
  requireMatch(
    state.role,
    slot.expectedRole,
    `task state role for ${slot.expectedTaskId}`,
  );
  requireMatch(state.taskId, slot.expectedTaskId, `task state taskId`);
  requireMatch(state.targetId, slot.expectedTargetId, `task state targetId`);
  return state;
}

function roleCounts(
  role: TaskRoleCounts["role"],
  planned: number,
  statuses: readonly (TaskState["status"] | null)[],
): TaskRoleCounts {
  const recorded = statuses.filter(
    (status): status is TaskState["status"] => status !== null,
  );
  if (recorded.length === 0) {
    return {
      role,
      planned,
      started: null,
      succeeded: null,
      failed: null,
      timeout: null,
      missingSubmission: null,
      invalid: null,
      uncertain: null,
    };
  }
  const count = (predicate: (status: TaskState["status"]) => boolean): number =>
    recorded.filter(predicate).length;
  return {
    role,
    planned,
    started: count((status) => status !== "pending"),
    succeeded: count((status) => status === "succeeded"),
    failed: count((status) => status === "failed"),
    timeout: count((status) => status === "timeout"),
    missingSubmission: count((status) => status === "missing_submission"),
    invalid: count((status) => status === "invalid"),
    uncertain: count((status) => status === "uncertain"),
  };
}

async function readVersionCompleteness(
  metadataPath: string,
): Promise<CallVersionCompleteness> {
  const read = await readExecutionMetadataFile(metadataPath);
  if (!read.exists || read.error !== null) return "unknown";
  return completenessOf(
    read.metadata.observedHarnessVersion,
    read.metadata.observedModelVersion,
  );
}

interface Interval {
  readonly startedMs: number;
  readonly completedMs: number;
}

function maximumObservedConcurrency(intervals: readonly Interval[]): number | null {
  if (intervals.length === 0) return null;
  // Closed-interval sweep: a call counts as concurrent with any other call
  // whose [start, completion] window shares a timestamp. Millisecond
  // timestamps cannot distinguish a same-instant completion-and-start from a
  // genuine overlap, so starts are processed before completions at equal
  // timestamps and the result is an inclusive upper observation. Zero-length
  // calls still observe a concurrency of one.
  type Event = { readonly at: number; readonly kind: "start" | "end" };
  const events: Event[] = [];
  for (const interval of intervals) {
    events.push({ at: interval.startedMs, kind: "start" });
    events.push({ at: interval.completedMs, kind: "end" });
  }
  events.sort((left, right) =>
    left.at !== right.at
      ? left.at - right.at
      : left.kind === right.kind
        ? 0
        : left.kind === "start"
          ? -1
          : 1,
  );
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    if (event.kind === "start") {
      active += 1;
      if (active > maximum) maximum = active;
    } else {
      active -= 1;
    }
  }
  return maximum;
}

function minimumStartIntervalMs(starts: readonly number[]): number | null {
  if (starts.length < 2) return null;
  const sorted = [...starts].sort((left, right) => left - right);
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index]! - sorted[index - 1]!;
    if (gap < minimum) minimum = gap;
  }
  return minimum;
}

export async function buildRunSummary(
  options: RunSummaryBuildOptions,
): Promise<RunSummary> {
  const generationPath = resolve(options.generationPath);
  const manifest = await readJsonWithSchema(
    join(generationPath, "manifest.json"),
    ManifestSchema,
  );
  requireMatch(
    basename(generationPath),
    manifest.generationId,
    "generation directory name",
  );

  const contestantsConfig = await readYamlWithSchema(
    join(generationPath, "config/contestants.yaml"),
    ContestantsConfigSchema,
  );
  const judgesConfig = await readYamlWithSchema(
    join(generationPath, "config/judges.yaml"),
    JudgesConfigSchema,
  );
  for (const contestantId of manifest.contestantIds) {
    const contestant = contestantsConfig.contestants.find(
      (entry) => entry.id === contestantId,
    );
    if (contestant === undefined || !contestant.enabled) {
      throw new Error(
        `run summary rejected manifest contestant missing from the copied config: ${contestantId}`,
      );
    }
  }
  for (const judgeId of manifest.judgeIds) {
    const judge = judgesConfig.judges.find((entry) => entry.id === judgeId);
    if (judge === undefined || !judge.enabled) {
      throw new Error(
        `run summary rejected manifest judge missing from the copied config: ${judgeId}`,
      );
    }
  }

  // Archived Phase 1 generations predate `run-plan.json`. They stay readable
  // with unavailable (null) plan-derived fields; nothing is fabricated.
  const runPlan = await readOptionalJson(
    join(generationPath, "run-plan.json"),
    RunPlanSchema,
  );
  if (runPlan !== null) {
    requireMatch(runPlan.generationId, manifest.generationId, "run plan generation ID");
    requireMatch(runPlan.seasonId, manifest.seasonId, "run plan season ID");
  }

  const anonymousMap = await readJsonWithSchema(
    join(generationPath, "judging/anonymous-map.json"),
    AnonymousMapSchema,
  );
  requireMatch(
    anonymousMap.generationId,
    manifest.generationId,
    "anonymous map generation ID",
  );
  const mapContestantIds = anonymousMap.entries
    .map((entry) => entry.contestantId)
    .sort(compareStrings);
  const manifestContestantIds = [...manifest.contestantIds].sort(compareStrings);
  if (
    mapContestantIds.length !== manifestContestantIds.length ||
    mapContestantIds.some(
      (contestantId, index) => contestantId !== manifestContestantIds[index],
    )
  ) {
    throw new Error("run summary rejected anonymous map roster mismatch");
  }
  const anonymousByContestant = new Map(
    anonymousMap.entries.map((entry) => [
      entry.contestantId,
      entry.anonymousCandidateId,
    ]),
  );
  const anonymousCandidateIds = anonymousMap.entries
    .map((entry) => entry.anonymousCandidateId)
    .sort(compareStrings);

  // ---- Contestants ---------------------------------------------------------

  const contestantRuns = new Map<string, Run>();
  const contestantTaskStatuses: (TaskState["status"] | null)[] = [];
  const renderTaskStatuses: (TaskState["status"] | null)[] = [];
  const contestantSummaries: RunSummary["contestants"] = [];
  const attemptedCalls: AttemptedCall[] = [];
  const groupStarts = new Map<string, { starts: number[]; intervals: Interval[] }>();

  for (const contestantId of [...manifest.contestantIds].sort(compareStrings)) {
    const contestantPath = join(generationPath, "contestants", contestantId);
    const anonymousCandidateId = anonymousByContestant.get(contestantId);
    if (anonymousCandidateId === undefined) {
      throw new Error(
        `run summary rejected missing anonymous map entry for contestant: ${contestantId}`,
      );
    }
    const identity = await readJsonWithSchema(
      join(contestantPath, "identity.json"),
      IdentitySchema,
    );
    requireMatch(
      identity.contestantId,
      contestantId,
      `identity contestant ID for ${contestantId}`,
    );
    requireMatch(
      identity.anonymousCandidateId,
      anonymousCandidateId,
      `identity anonymous candidate ID for ${contestantId}`,
    );
    const run = await readJsonWithSchema(join(contestantPath, "run.json"), RunSchema);
    requireMatch(
      run.taskId,
      `${manifest.generationId}-contestant-${anonymousCandidateId}`,
      `contestant run task ID for ${contestantId}`,
    );
    contestantRuns.set(contestantId, run);

    const executionTask = await readTaskSlot({
      path: join(contestantPath, "task.json"),
      expectedRole: "contestant",
      expectedTargetId: contestantId,
      // The durable contestant task state is keyed by the *contestant* ID
      // (`taskIdentifier(generationId, "contestant", contestantId)` in the
      // orchestrator), while `run.json` keeps the anonymous-candidate task ID
      // from the planning packet. These are two deliberate, distinct durable
      // conventions; the summary validates each against its own form.
      expectedTaskId: `${manifest.generationId}-contestant-${contestantId}`,
    });
    contestantTaskStatuses.push(executionTask === null ? null : executionTask.status);
    renderTaskStatuses.push(
      (
        await readTaskSlot({
          path: join(contestantPath, "render-task.json"),
          expectedRole: "render",
          expectedTargetId: contestantId,
          expectedTaskId: `${manifest.generationId}-render-${contestantId}`,
        })
      )?.status ?? null,
    );

    const configEntry = contestantsConfig.contestants.find(
      (entry) => entry.id === contestantId,
    )!;
    contestantSummaries.push({
      contestantId,
      anonymousCandidateId,
      durationMs: run.durationMs,
      usage: {
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        reasoningTokens: run.usage.reasoningTokens,
        totalTokens: run.usage.totalTokens,
      },
      estimatedCostUsd: run.usage.estimatedCostUsd,
      versionCompleteness: completenessOf(
        run.observedVersions.harness,
        run.observedVersions.model,
      ),
      oneShotEnforcement: configEntry.execution?.oneShotEnforcement ?? null,
    });

    if (run.status !== "pending") {
      attemptedCalls.push({
        reportsReasoning: true,
        reasoningTokens: run.usage.reasoningTokens,
        usage: {
          inputTokens: run.usage.inputTokens,
          outputTokens: run.usage.outputTokens,
          totalTokens: run.usage.totalTokens,
        },
        estimatedCostUsd: run.usage.estimatedCostUsd,
      });
      if (configEntry.execution?.resourceGroup !== undefined) {
        const group = configEntry.execution.resourceGroup;
        const observation = groupStarts.get(group) ?? { starts: [], intervals: [] };
        if (run.startedAt !== null) {
          observation.starts.push(Date.parse(run.startedAt));
          if (run.completedAt !== null) {
            observation.intervals.push({
              startedMs: Date.parse(run.startedAt),
              completedMs: Date.parse(run.completedAt),
            });
          }
        }
        groupStarts.set(group, observation);
      }
    }
  }

  // ---- Judges ---------------------------------------------------------------

  const judgeTaskStatuses: (TaskState["status"] | null)[] = [];
  const awardsTaskStatuses: (TaskState["status"] | null)[] = [];
  const judgeSummaries: RunSummary["judges"] = [];

  for (const judgeId of [...manifest.judgeIds].sort(compareStrings)) {
    const judgePath = join(generationPath, "judging", judgeId);
    const timings = await readOptionalJson(
      join(judgePath, "task-timings.json"),
      JudgeTaskTimingsSchema,
    );
    if (timings !== null) {
      requireMatch(
        timings.generationId,
        manifest.generationId,
        "judge timings generation ID",
      );
      requireMatch(timings.judgeId, judgeId, "judge timings judge ID");
    }
    const timingByCandidate = new Map<
      string,
      { startedAt: string; completedAt: string; durationMs: number }
    >();
    let awardsTiming: {
      startedAt: string;
      completedAt: string;
      durationMs: number;
    } | null = null;
    for (const entry of timings?.tasks ?? []) {
      if (entry.operation === "awards") {
        if (awardsTiming !== null) {
          throw new Error(
            `run summary rejected duplicate awards timing for judge ${judgeId}`,
          );
        }
        awardsTiming = {
          startedAt: entry.startedAt,
          completedAt: entry.completedAt,
          durationMs: entry.durationMs,
        };
        continue;
      }
      const anonymousCandidateId = entry.anonymousCandidateId;
      if (anonymousCandidateId === null) {
        throw new Error(
          `run summary rejected candidate timing without candidate for judge ${judgeId}`,
        );
      }
      if (!anonymousCandidateIds.includes(anonymousCandidateId)) {
        throw new Error(
          `run summary rejected unknown anonymous candidate in judge timings: ${anonymousCandidateId}`,
        );
      }
      if (timingByCandidate.has(anonymousCandidateId)) {
        throw new Error(
          `run summary rejected duplicate candidate timing for judge ${judgeId}: ${anonymousCandidateId}`,
        );
      }
      timingByCandidate.set(anonymousCandidateId, {
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
        durationMs: entry.durationMs,
      });
    }

    const configEntry = judgesConfig.judges.find((entry) => entry.id === judgeId)!;
    const candidateCalls: RunSummary["judges"][number]["candidateCalls"] = [];
    for (const anonymousCandidateId of anonymousCandidateIds) {
      const judgment = await readOptionalJson(
        join(judgePath, `${anonymousCandidateId}.json`),
        CandidateJudgmentSchema,
      );
      if (judgment !== null) {
        requireMatch(
          judgment.generationId,
          manifest.generationId,
          `judgment generation ID for judge ${judgeId}`,
        );
        requireMatch(
          judgment.judgeId,
          judgeId,
          `judgment judge ID for ${anonymousCandidateId}`,
        );
        requireMatch(
          judgment.anonymousCandidateId,
          anonymousCandidateId,
          `judgment anonymous candidate ID for judge ${judgeId}`,
        );
      }
      const taskState = await readTaskSlot({
        path: join(judgePath, "tasks", `${anonymousCandidateId}.json`),
        expectedRole: "judge",
        expectedTargetId: `${judgeId}\0${anonymousCandidateId}`,
        expectedTaskId: `${manifest.generationId}-judge-${judgeId}-${anonymousCandidateId}`,
      });
      judgeTaskStatuses.push(taskState === null ? null : taskState.status);

      const usagePath = join(judgePath, "usage", `${anonymousCandidateId}.json`);
      const usageRead = await readUsageFile(usagePath);
      let usage: NullableUsage = UNKNOWN_USAGE;
      let estimatedCostUsd: number | null = null;
      if (usageRead.exists && usageRead.error === null) {
        usage = {
          inputTokens: usageRead.usage.inputTokens,
          outputTokens: usageRead.usage.outputTokens,
          totalTokens: usageRead.usage.totalTokens,
        };
        estimatedCostUsd = usageRead.usage.estimatedCostUsd;
      } else if (!usageRead.exists && judgment !== null) {
        usage = {
          inputTokens: judgment.modelUsage.inputTokens,
          outputTokens: judgment.modelUsage.outputTokens,
          totalTokens: judgment.modelUsage.totalTokens,
        };
        estimatedCostUsd = judgment.modelUsage.estimatedCostUsd;
      }
      const timing = timingByCandidate.get(anonymousCandidateId);
      const attempted =
        (taskState !== null && taskState.status !== "pending") ||
        timing !== undefined ||
        judgment !== null ||
        usageRead.exists;
      const versionCompleteness = await readVersionCompleteness(
        join(judgePath, "execution-metadata", `${anonymousCandidateId}.json`),
      );
      candidateCalls.push({
        anonymousCandidateId,
        durationMs: timing?.durationMs ?? null,
        usage,
        estimatedCostUsd,
        versionCompleteness,
      });
      if (attempted) {
        attemptedCalls.push({
          reportsReasoning: false,
          reasoningTokens: null,
          usage,
          estimatedCostUsd,
        });
      }
      if (configEntry.execution?.resourceGroup !== undefined && timing !== undefined) {
        const observation = groupStarts.get(configEntry.execution.resourceGroup) ?? {
          starts: [],
          intervals: [],
        };
        observation.starts.push(Date.parse(timing.startedAt));
        observation.intervals.push({
          startedMs: Date.parse(timing.startedAt),
          completedMs: Date.parse(timing.completedAt),
        });
        groupStarts.set(configEntry.execution.resourceGroup, observation);
      }
    }

    const awardsJson = await readOptionalJson(
      join(judgePath, "awards.json"),
      GenerationAwardsSchema,
    );
    if (awardsJson !== null) {
      requireMatch(
        awardsJson.generationId,
        manifest.generationId,
        `awards generation ID for judge ${judgeId}`,
      );
      requireMatch(awardsJson.judgeId, judgeId, `awards judge ID`);
    }
    const awardsTask = await readTaskSlot({
      path: join(judgePath, "awards-task.json"),
      expectedRole: "awards",
      expectedTargetId: judgeId,
      expectedTaskId: `${manifest.generationId}-awards-${judgeId}`,
    });
    awardsTaskStatuses.push(awardsTask === null ? null : awardsTask.status);
    const awardsUsageRead = await readUsageFile(
      join(judgePath, "usage", "awards.json"),
    );
    let awardsUsage: NullableUsage = UNKNOWN_USAGE;
    let awardsCost: number | null = null;
    if (awardsUsageRead.exists && awardsUsageRead.error === null) {
      awardsUsage = {
        inputTokens: awardsUsageRead.usage.inputTokens,
        outputTokens: awardsUsageRead.usage.outputTokens,
        totalTokens: awardsUsageRead.usage.totalTokens,
      };
      awardsCost = awardsUsageRead.usage.estimatedCostUsd;
    }
    const awardsAttempted =
      (awardsTask !== null && awardsTask.status !== "pending") ||
      awardsTiming !== null ||
      awardsJson !== null ||
      awardsUsageRead.exists;
    const awardsVersionCompleteness = await readVersionCompleteness(
      join(judgePath, "execution-metadata", "awards.json"),
    );
    judgeSummaries.push({
      judgeId,
      candidateCalls,
      awardsCall: {
        durationMs: awardsTiming?.durationMs ?? null,
        usage: awardsUsage,
        estimatedCostUsd: awardsCost,
        versionCompleteness: awardsVersionCompleteness,
      },
    });
    if (awardsAttempted) {
      attemptedCalls.push({
        reportsReasoning: false,
        reasoningTokens: null,
        usage: awardsUsage,
        estimatedCostUsd: awardsCost,
      });
    }
    if (configEntry.execution?.resourceGroup !== undefined && awardsTiming !== null) {
      const observation = groupStarts.get(configEntry.execution.resourceGroup) ?? {
        starts: [],
        intervals: [],
      };
      observation.starts.push(Date.parse(awardsTiming.startedAt));
      observation.intervals.push({
        startedMs: Date.parse(awardsTiming.startedAt),
        completedMs: Date.parse(awardsTiming.completedAt),
      });
      groupStarts.set(configEntry.execution.resourceGroup, observation);
    }
  }

  // ---- Leaderboard cross-check (optional durable artifact) ------------------

  const leaderboard = await readOptionalJson(
    join(generationPath, "leaderboard.json"),
    LeaderboardSchema,
  );
  if (leaderboard !== null) {
    requireMatch(
      leaderboard.generationId,
      manifest.generationId,
      "leaderboard generation ID",
    );
    requireMatch(leaderboard.seasonId, manifest.seasonId, "leaderboard season ID");
    const leaderboardIds = leaderboard.entries
      .map((entry) => entry.contestantId)
      .sort(compareStrings);
    if (
      leaderboardIds.length !== manifestContestantIds.length ||
      leaderboardIds.some((id, index) => id !== manifestContestantIds[index])
    ) {
      throw new Error("run summary rejected leaderboard roster mismatch");
    }
  }

  // ---- Aggregates -----------------------------------------------------------

  // Contestant task-state files are written only by resumable runs. When no
  // contestant task-state artifact exists, the durable `run.json` status is
  // the original per-contestant task evidence; other roles stay unknown.
  const contestantCounts =
    contestantTaskStatuses.some((status) => status !== null) ||
    manifest.contestantIds.length === 0
      ? roleCounts("contestant", manifest.contestantIds.length, contestantTaskStatuses)
      : roleCounts(
          "contestant",
          manifest.contestantIds.length,
          [...contestantRuns.values()].map((run) => run.status),
        );

  const taskCounts: TaskRoleCounts[] = [
    contestantCounts,
    roleCounts("render", manifest.contestantIds.length, renderTaskStatuses),
    roleCounts(
      "judge",
      manifest.contestantIds.length * manifest.judgeIds.length,
      judgeTaskStatuses,
    ),
    roleCounts("awards", manifest.judgeIds.length, awardsTaskStatuses),
  ];

  const totals = {
    inputTokens: aggregateIntegers(
      attemptedCalls.map((call) => call.usage.inputTokens),
    ),
    outputTokens: aggregateIntegers(
      attemptedCalls.map((call) => call.usage.outputTokens),
    ),
    reasoningTokens: aggregateIntegers(
      attemptedCalls
        .filter((call) => call.reportsReasoning)
        .map((call) => call.reasoningTokens),
    ),
    totalTokens: aggregateIntegers(
      attemptedCalls.map((call) => call.usage.totalTokens),
    ),
    estimatedCostUsd: aggregateNumbers(
      attemptedCalls.map((call) => call.estimatedCostUsd),
    ),
    callsWithUnknownUsage: attemptedCalls.filter((call) => usageIsUnknown(call.usage))
      .length,
    callsWithUnknownCost: attemptedCalls.filter(
      (call) => call.estimatedCostUsd === null,
    ).length,
  };

  // Group declarations merge exactly like the run planner: the contestants
  // file overrides a same-named judges-file declaration.
  const declaredGroups: Record<
    string,
    { maximumConcurrency: number; minimumStartIntervalMs: number }
  > = {
    ...(judgesConfig.resourceGroups ?? {}),
    ...(contestantsConfig.resourceGroups ?? {}),
  };
  const resourceGroups = Object.keys(declaredGroups)
    .sort(compareStrings)
    .map((name) => {
      const declaration = declaredGroups[name]!;
      const observation = groupStarts.get(name) ?? { starts: [], intervals: [] };
      return {
        name,
        configuredMaximumConcurrency: declaration.maximumConcurrency,
        configuredMinimumStartIntervalMs: declaration.minimumStartIntervalMs,
        observedStartCount: observation.starts.length,
        observedMaximumConcurrency: maximumObservedConcurrency(observation.intervals),
        observedMinimumStartIntervalMs: minimumStartIntervalMs(observation.starts),
      };
    });

  const wallClockElapsedMs =
    manifest.startedAt !== null && manifest.completedAt !== null
      ? elapsedMsBetween(manifest.startedAt, manifest.completedAt)
      : null;

  const generatedAt = UtcTimestampSchema.parse(
    options.generatedAt ?? manifest.completedAt ?? manifest.createdAt,
  );

  return RunSummarySchema.parse({
    schemaVersion: 1,
    seasonId: manifest.seasonId,
    generationId: manifest.generationId,
    generatedAt,
    wallClock: {
      startedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
      elapsedMs: wallClockElapsedMs,
    },
    taskCounts,
    contestants: contestantSummaries,
    judges: judgeSummaries,
    totals,
    configuredMaximumCalls: runPlan?.callCounts.maximumTotalCalls ?? null,
    resourceGroups,
  });
}

/** The exact canonical bytes `run-summary.json` carries: pretty JSON plus a trailing newline. */
export function serializeRunSummary(summary: RunSummary): string {
  return `${JSON.stringify(RunSummarySchema.parse(summary), null, 2)}\n`;
}

/** Atomically writes the private durable `run-summary.json` artifact. */
export async function writeRunSummary(
  generationPath: string,
  summary: RunSummary,
): Promise<string> {
  const path = join(resolve(generationPath), RUN_SUMMARY_FILE_NAME);
  await writeTextAtomically(path, serializeRunSummary(summary));
  return path;
}

/**
 * Regenerates the private, durable `run-summary.json` for one generation from
 * its copied artifacts alone. This is a pure read/derive/write of generation
 * files: it never invokes contestant or judge adapters, never executes model
 * commands, and never requires model-call consent. Because the summary
 * timestamp comes from the durable manifest completion, re-running this over
 * unchanged artifacts reproduces byte-identical output.
 */
export async function summarizeGeneration(generationPath: string): Promise<string> {
  const resolved = resolve(generationPath);
  const summary = await buildRunSummary({ generationPath: resolved });
  return writeRunSummary(resolved, summary);
}
