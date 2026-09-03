import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { resolveProfile, type ResolvedProfile } from "../../src/config/profiles.js";
import { createTestTempRoot } from "./temp-roots.js";

export function commandContestant(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    displayName: `Command ${id}`,
    harness: {
      name: "example-harness",
      version: "2.1.0",
      adapter: "command",
      command: {
        argv: [
          "/absolute/path/to/harness",
          "--prompt",
          "{promptPath}",
          "--output",
          "{submissionPath}",
          "--usage",
          "{usageOutputPath}",
        ],
        environmentAllowlist: [],
      },
    },
    model: { provider: "example", name: "example-model", version: "1.2.3" },
    execution: { resourceGroup: "lane", oneShotEnforcement: "enforced" },
    enabled: true,
    ...overrides,
  };
}

export function commandJudge(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    displayName: `Judge ${id}`,
    harness: {
      name: "example-judge-harness",
      version: "2.1.0",
      adapter: "command",
      command: {
        argv: [
          "/absolute/path/to/judge",
          "--prompt",
          "{promptPath}",
          "--output",
          "{judgmentPath}",
          "--usage",
          "{usageOutputPath}",
        ],
        environmentAllowlist: [],
      },
    },
    model: { provider: "example", name: "judge-model", version: "1.2.3" },
    execution: { resourceGroup: "lane", oneShotEnforcement: "enforced" },
    enabled: true,
    ...overrides,
  };
}

export function fixtureContestant(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    displayName: `Fixture ${id}`,
    harness: {
      name: "fixture-harness",
      version: "1.0.0",
      adapter: "fixture",
      fixture: "editorial",
    },
    model: { provider: "local-fixture", name: `${id}-model`, version: "1.0.0" },
    enabled: true,
    ...overrides,
  };
}

export function fixtureJudge(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    displayName: `Fixture ${id}`,
    harness: {
      name: "fixture-judge",
      version: "1.0.0",
      adapter: "fixture",
      fixture: "critic-a",
    },
    model: { provider: "local-fixture", name: `${id}-model`, version: "1.0.0" },
    enabled: true,
    ...overrides,
  };
}

export const defaultResourceGroups = {
  lane: { maximumConcurrency: 2, minimumStartIntervalMs: 500 },
};

export function contestantsDocument(
  contestants: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 2,
    defaults: {
      timeoutMs: 480000,
      maximumTotalTokens: 30000,
      maximumSubmissionBytes: 61440,
      concurrency: 4,
    },
    resourceGroups: defaultResourceGroups,
    contestants,
    ...overrides,
  };
}

export function judgesDocument(
  judges: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 2,
    defaults: {
      timeoutMs: 180000,
      maximumOutputTokens: 4000,
      concurrencyPerJudge: 2,
    },
    resourceGroups: defaultResourceGroups,
    judges,
    ...overrides,
  };
}

export async function profileFromDocuments(
  contestants: Record<string, unknown>,
  judges: Record<string, unknown>,
  profileId = "temp",
): Promise<{ root: string; profile: ResolvedProfile }> {
  const parent = await createTestTempRoot("local-maxima-plan-repo-");
  const profileRoot = join(parent, "config", "profiles", profileId);
  await mkdir(profileRoot, { recursive: true });
  await writeFile(join(profileRoot, "contestants.yaml"), stringifyYaml(contestants));
  await writeFile(join(profileRoot, "judges.yaml"), stringifyYaml(judges));
  const profile = await resolveProfile(parent, profileId);
  return { root: parent, profile };
}
