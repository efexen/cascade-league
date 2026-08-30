import type { ResolvedProfile } from "../config/profiles.js";
import type { ContestantConfig, JudgeConfig, RunPlan } from "../schemas/index.js";

export interface RunPlanConfigSnapshotHashes {
  readonly "config/contestants.yaml": string;
  readonly "config/judges.yaml": string;
  readonly "config/profile.json": string;
}

export interface RunPlanBuilderInput {
  readonly profile: ResolvedProfile;
  readonly seasonId: string;
  readonly generationId: string;
  readonly previousGenerationId: string | null;
  readonly configSnapshotHashes: RunPlanConfigSnapshotHashes;
  readonly promptOnlyOneShotAccepted: boolean;
}

type CommandContestant = ContestantConfig & {
  harness: { adapter: "command"; command: { argv: string[] } };
};
type CommandJudge = JudgeConfig & {
  harness: { adapter: "command"; command: { argv: string[] } };
};

function isCommandContestant(entry: ContestantConfig): entry is CommandContestant {
  return entry.harness.adapter === "command";
}

function isCommandJudge(entry: JudgeConfig): entry is CommandJudge {
  return entry.harness.adapter === "command";
}

function isPromptOnly(
  entry: ContestantConfig | JudgeConfig,
): entry is ContestantConfig & { execution: { oneShotEnforcement: "prompt_only" } } {
  return entry.execution?.oneShotEnforcement === "prompt_only";
}

/**
 * Builds the deterministic run plan for one generation. This is a pure
 * function: no filesystem access, no timestamps, and no model calls. The
 * caller supplies the resolved profile, the season/generation coordinates,
 * and the SHA-256 hashes of the exact configuration bytes that will be (or
 * were) copied into the generation. Identical inputs always produce
 * byte-identical JSON.
 */
export function buildRunPlan(input: RunPlanBuilderInput): RunPlan {
  const { profile } = input;
  const enabledContestants = profile.contestants.contestants.filter(
    (contestant) => contestant.enabled,
  );
  const enabledJudges = profile.judges.judges.filter((judge) => judge.enabled);
  const commandContestants = enabledContestants.filter(isCommandContestant);
  const commandJudges = enabledJudges.filter(isCommandJudge);

  const contestantCalls = enabledContestants.length;
  const candidateJudgingCalls = enabledContestants.length * enabledJudges.length;
  const awardsCalls = enabledJudges.length;

  const declaredGroups = Object.entries({
    ...profile.judges.resourceGroups,
    ...profile.contestants.resourceGroups,
  }).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const resourceGroups: RunPlan["resourceGroups"] = {};
  for (const [name, declaration] of declaredGroups) {
    const entryIds = [
      ...commandContestants
        .filter((contestant) => contestant.execution?.resourceGroup === name)
        .map((contestant) => contestant.id),
      ...commandJudges
        .filter((judge) => judge.execution?.resourceGroup === name)
        .map((judge) => judge.id),
    ];
    resourceGroups[name] = {
      maximumConcurrency: declaration.maximumConcurrency,
      minimumStartIntervalMs: declaration.minimumStartIntervalMs,
      entryIds,
    };
  }

  return {
    schemaVersion: 1,
    seasonId: input.seasonId,
    generationId: input.generationId,
    previousGenerationId: input.previousGenerationId,
    profileId: profile.profileId,
    contestants: enabledContestants.map((contestant) => ({
      id: contestant.id,
      displayName: contestant.displayName,
    })),
    judges: enabledJudges.map((judge) => ({
      id: judge.id,
      displayName: judge.displayName,
    })),
    externalModelCallsRequired:
      commandContestants.length > 0 || commandJudges.length > 0,
    callCounts: {
      contestantCalls,
      candidateJudgingCalls,
      awardsCalls,
      maximumTotalCalls: contestantCalls + candidateJudgingCalls + awardsCalls,
    },
    ceilings: {
      contestants: enabledContestants.map((contestant) => ({
        id: contestant.id,
        timeoutMs:
          contestant.budget?.timeoutMs ?? profile.contestants.defaults.timeoutMs,
        maximumTotalTokens:
          contestant.budget?.maximumTotalTokens ??
          profile.contestants.defaults.maximumTotalTokens,
      })),
      judges: enabledJudges.map((judge) => ({
        id: judge.id,
        timeoutMs: judge.budget?.timeoutMs ?? profile.judges.defaults.timeoutMs,
        maximumOutputTokens:
          judge.budget?.maximumOutputTokens ??
          profile.judges.defaults.maximumOutputTokens,
      })),
    },
    resourceGroups,
    usageReportingUnsupported: [
      ...commandContestants
        .filter(
          (contestant) =>
            !contestant.harness.command.argv.includes("{usageOutputPath}"),
        )
        .map((contestant) => contestant.id),
      ...commandJudges
        .filter((judge) => !judge.harness.command.argv.includes("{usageOutputPath}"))
        .map((judge) => judge.id),
    ],
    promptOnlyOneShot: commandContestants.filter(isPromptOnly).map((c) => c.id),
    promptOnlyOneShotAccepted: input.promptOnlyOneShotAccepted,
    configSnapshotHashes: {
      "config/contestants.yaml": input.configSnapshotHashes["config/contestants.yaml"],
      "config/judges.yaml": input.configSnapshotHashes["config/judges.yaml"],
      "config/profile.json": input.configSnapshotHashes["config/profile.json"],
    },
  };
}
