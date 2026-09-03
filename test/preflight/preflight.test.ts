import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { resolveProfile, type ResolvedProfile } from "../../src/config/profiles.js";
import {
  runProfilePreflightChecks,
  runRepositoryPreflight,
} from "../../src/preflight/index.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

function commandContestant(id: string, overrides: Record<string, unknown> = {}) {
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

function commandJudge(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    displayName: `Judge ${id}`,
    harness: {
      name: "example-judge-harness",
      version: "2.1.0",
      adapter: "command",
      command: {
        argv: ["/absolute/path/to/judge", "--prompt", "{promptPath}", "{judgmentPath}"],
        environmentAllowlist: [],
      },
    },
    model: { provider: "example", name: "judge-model", version: "1.2.3" },
    execution: { resourceGroup: "lane", oneShotEnforcement: "enforced" },
    enabled: true,
    ...overrides,
  };
}

export function contestantsDocument(
  contestants: readonly Record<string, unknown>[],
  resourceGroups: Record<string, unknown> = {
    lane: { maximumConcurrency: 2, minimumStartIntervalMs: 0 },
  },
) {
  return {
    schemaVersion: 2,
    defaults: {
      timeoutMs: 480000,
      maximumTotalTokens: 30000,
      maximumSubmissionBytes: 61440,
      concurrency: 4,
    },
    resourceGroups,
    contestants,
  };
}

export function judgesDocument(
  judges: readonly Record<string, unknown>[],
  resourceGroups: Record<string, unknown> = {
    lane: { maximumConcurrency: 2, minimumStartIntervalMs: 0 },
  },
) {
  return {
    schemaVersion: 2,
    defaults: {
      timeoutMs: 180000,
      maximumOutputTokens: 4000,
      concurrencyPerJudge: 2,
    },
    resourceGroups,
    judges,
  };
}

async function profileFromDocuments(
  contestants: Record<string, unknown>,
  judges: Record<string, unknown>,
): Promise<ResolvedProfile> {
  const parent = await createTestTempRoot("local-maxima-preflight-repo-");
  const profileRoot = join(parent, "config", "profiles", "temp");
  await mkdir(profileRoot, { recursive: true });
  await writeFile(join(profileRoot, "contestants.yaml"), stringifyYaml(contestants));
  await writeFile(join(profileRoot, "judges.yaml"), stringifyYaml(judges));
  return resolveProfile(parent, "temp");
}

describe("profile preflight: enabled_roster", () => {
  it("errors when fewer than two contestants are enabled", async () => {
    const profile = await profileFromDocuments(
      contestantsDocument([
        commandContestant("one"),
        commandContestant("two", { enabled: false }),
        commandContestant("three", { enabled: false }),
      ]),
      judgesDocument([commandJudge("judge-a")]),
    );
    const issues = await runProfilePreflightChecks(profile, {});
    const roster = issues.filter((entry) => entry.code === "enabled_roster");
    expect(roster).toHaveLength(1);
    expect(roster[0]!.severity).toBe("error");
    expect(roster[0]!.message).toMatch(/enabled contestant/i);
  });

  it("errors when no judge is enabled", async () => {
    const profile = await profileFromDocuments(
      contestantsDocument([commandContestant("one"), commandContestant("two")]),
      judgesDocument([commandJudge("judge-a", { enabled: false })]),
    );
    const issues = await runProfilePreflightChecks(profile, {});
    const roster = issues.filter((entry) => entry.code === "enabled_roster");
    expect(roster).toHaveLength(1);
    expect(roster[0]!.message).toMatch(/enabled judge/i);
  });

  it("accepts a two-contestant one-judge enabled roster", async () => {
    const profile = await profileFromDocuments(
      contestantsDocument([commandContestant("one"), commandContestant("two")]),
      judgesDocument([commandJudge("judge-a")]),
    );
    const issues = await runProfilePreflightChecks(profile, {});
    expect(issues.filter((entry) => entry.code === "enabled_roster")).toHaveLength(0);
  });
});

describe("repository preflight season selection", () => {
  it("checks the requested normalized season instead of season-001", async () => {
    const parent = await createTestTempRoot("local-maxima-season-preflight-");
    await cp(
      join(repositoryRoot, "challenge/season-001"),
      join(parent, "challenge/season-002"),
      { recursive: true },
    );
    const seasonConfigPath = join(parent, "challenge/season-002/challenge.yaml");
    await writeFile(
      seasonConfigPath,
      (await readFile(seasonConfigPath, "utf8")).replace(
        'seasonId: "0001"',
        'seasonId: "0002"',
      ),
      "utf8",
    );
    const seedDataPath = join(parent, "challenge/season-002/seed/seed-generation.json");
    await writeFile(
      seedDataPath,
      (await readFile(seedDataPath, "utf8")).replace(
        '"seasonId": "0001"',
        '"seasonId": "0002"',
      ),
      "utf8",
    );
    await mkdir(join(parent, "config/profiles"), { recursive: true });
    await cp(
      join(repositoryRoot, "config/profiles/fixture"),
      join(parent, "config/profiles/fixture"),
      { recursive: true },
    );

    const report = await runRepositoryPreflight(parent, "fixture", {
      seasonId: "0002",
      environment: {},
    });
    expect(report.issues.filter((entry) => entry.code === "challenge_inputs")).toEqual(
      [],
    );
    expect(report.issues.filter((entry) => entry.code === "seed_asset")).toEqual([]);
  });
});

describe("profile preflight: environment_variable", () => {
  it("errors once per enabled command entry whose allowlisted variable is missing", async () => {
    const profile = await profileFromDocuments(
      contestantsDocument([
        commandContestant("one", {
          harness: {
            ...commandContestant("one").harness,
            command: {
              argv: [
                "/absolute/path/to/harness",
                "--prompt",
                "{promptPath}",
                "--output",
                "{submissionPath}",
              ],
              environmentAllowlist: ["EXAMPLE_API_KEY"],
            },
          },
        }),
        commandContestant("two"),
      ]),
      judgesDocument([
        commandJudge("judge-a", {
          harness: {
            ...commandJudge("judge-a").harness,
            command: {
              argv: ["/absolute/path/to/judge", "{promptPath}", "{judgmentPath}"],
              environmentAllowlist: ["EXAMPLE_API_KEY"],
            },
          },
        }),
      ]),
    );
    const missing = await runProfilePreflightChecks(profile, {});
    const envIssues = missing.filter((entry) => entry.code === "environment_variable");
    expect(envIssues).toHaveLength(2);
    expect(envIssues.every((entry) => entry.severity === "error")).toBe(true);
    expect(envIssues.map((entry) => entry.message).join("\n")).toContain(
      "EXAMPLE_API_KEY",
    );
    const present = await runProfilePreflightChecks(profile, {
      EXAMPLE_API_KEY: "set-by-operator",
    });
    expect(
      present.filter((entry) => entry.code === "environment_variable"),
    ).toHaveLength(0);
  });
});

describe("profile preflight: argv environment references", () => {
  it("errors on a reference outside the entry allowlist and warns on one inside it", async () => {
    const profile = await profileFromDocuments(
      contestantsDocument([
        commandContestant("one", {
          harness: {
            name: "example-harness",
            version: "2.1.0",
            adapter: "command",
            command: {
              argv: [
                "/absolute/path/to/harness",
                "--token",
                "$SECRET_TOKEN",
                "--key",
                "$EXAMPLE_API_KEY",
                "--model",
                "$MODEL_NAME",
                "--prompt",
                "{promptPath}",
                "--output",
                "{submissionPath}",
              ],
              environmentAllowlist: ["EXAMPLE_API_KEY"],
            },
          },
        }),
        commandContestant("two"),
      ]),
      judgesDocument([commandJudge("judge-a")]),
    );
    const issues = await runProfilePreflightChecks(profile, {
      EXAMPLE_API_KEY: "present",
    });
    const outside = issues.filter(
      (entry) => entry.code === "environment_reference_outside_allowlist",
    );
    expect(outside).toHaveLength(2);
    expect(outside.every((entry) => entry.severity === "error")).toBe(true);
    expect(outside.map((entry) => entry.message).join("\n")).toContain("SECRET_TOKEN");
    expect(outside.map((entry) => entry.message).join("\n")).toContain("MODEL_NAME");
    const notExpanded = issues.filter(
      (entry) => entry.code === "environment_reference_not_expanded",
    );
    expect(notExpanded).toHaveLength(1);
    expect(notExpanded[0]!.severity).toBe("warning");
    expect(notExpanded[0]!.message).toContain("EXAMPLE_API_KEY");
  });
});

describe("profile preflight: placeholder_compatibility", () => {
  it("errors when a contestant argv cannot direct its submission output", async () => {
    const profile = await profileFromDocuments(
      contestantsDocument([
        commandContestant("one", {
          harness: {
            name: "example-harness",
            version: "2.1.0",
            adapter: "command",
            command: {
              argv: ["/absolute/path/to/harness", "--prompt", "{promptPath}"],
              environmentAllowlist: [],
            },
          },
        }),
        commandContestant("two"),
      ]),
      judgesDocument([commandJudge("judge-a")]),
    );
    const issues = await runProfilePreflightChecks(profile, {});
    const compat = issues.filter((entry) => entry.code === "placeholder_compatibility");
    expect(compat).toHaveLength(1);
    expect(compat[0]!.severity).toBe("error");
    expect(compat[0]!.message).toContain("one");
    expect(compat[0]!.message).toMatch(/submissionPath/);
  });

  it("errors when a judge argv has no output placeholder but accepts either alias", async () => {
    const missingOutput = await profileFromDocuments(
      contestantsDocument([commandContestant("one"), commandContestant("two")]),
      judgesDocument([
        commandJudge("judge-a", {
          harness: {
            name: "example-judge-harness",
            version: "2.1.0",
            adapter: "command",
            command: {
              argv: ["/absolute/path/to/judge", "{promptPath}"],
              environmentAllowlist: [],
            },
          },
        }),
      ]),
    );
    const issues = await runProfilePreflightChecks(missingOutput, {});
    expect(
      issues.filter((entry) => entry.code === "placeholder_compatibility"),
    ).toHaveLength(1);

    const awardsOnly = await profileFromDocuments(
      contestantsDocument([commandContestant("one"), commandContestant("two")]),
      judgesDocument([
        commandJudge("judge-a", {
          harness: {
            name: "example-judge-harness",
            version: "2.1.0",
            adapter: "command",
            command: {
              argv: ["/absolute/path/to/judge", "{promptPath}", "{awardsPath}"],
              environmentAllowlist: [],
            },
          },
        }),
      ]),
    );
    expect(
      (await runProfilePreflightChecks(awardsOnly, {})).filter(
        (entry) => entry.code === "placeholder_compatibility",
      ),
    ).toHaveLength(0);
  });
});

describe("profile preflight: one_shot_prompt_only", () => {
  it("warns for each enabled command contestant enforced prompt-only", async () => {
    const profile = await profileFromDocuments(
      contestantsDocument([
        commandContestant("one", {
          execution: { resourceGroup: "lane", oneShotEnforcement: "prompt_only" },
        }),
        commandContestant("two", {
          execution: { resourceGroup: "lane", oneShotEnforcement: "enforced" },
        }),
      ]),
      judgesDocument([
        commandJudge("judge-a", {
          execution: { resourceGroup: "lane", oneShotEnforcement: "prompt_only" },
        }),
      ]),
    );
    const issues = await runProfilePreflightChecks(profile, {});
    const promptOnly = issues.filter((entry) => entry.code === "one_shot_prompt_only");
    expect(promptOnly).toHaveLength(1);
    expect(promptOnly[0]!.severity).toBe("warning");
    expect(promptOnly[0]!.message).toContain("one");
  });
});

describe("profile preflight: version_genericity", () => {
  it("errors for enabled command entries with missing or generic versions", async () => {
    const profile = await profileFromDocuments(
      contestantsDocument([
        commandContestant("one", {
          harness: {
            ...commandContestant("one").harness,
            version: undefined,
          },
        }),
        commandContestant("two", {
          model: {
            provider: "example",
            name: "example-model",
            version: "Record-At-Run-Time",
          },
        }),
      ]),
      judgesDocument([
        commandJudge("judge-a", {
          harness: {
            ...commandJudge("judge-a").harness,
            version: "latest",
          },
        }),
      ]),
    );
    const issues = await runProfilePreflightChecks(profile, {});
    const generic = issues.filter((entry) => entry.code === "version_genericity");
    expect(generic).toHaveLength(3);
    expect(generic.every((entry) => entry.severity === "error")).toBe(true);
    expect(generic.map((entry) => entry.message).join("\n")).toContain("one");
    expect(generic.map((entry) => entry.message).join("\n")).toContain("two");
    expect(generic.map((entry) => entry.message).join("\n")).toContain("judge-a");
  });

  it("exempts fixture-adapter entries from version genericity", async () => {
    const profile = await resolveProfile(repositoryRoot, "fixture");
    const issues = await runProfilePreflightChecks(profile, {});
    expect(issues.filter((entry) => entry.code === "version_genericity")).toHaveLength(
      0,
    );
  });
});

describe("preflight against the checked-in fixture profile", () => {
  it("reports no issues for the fixture profile", async () => {
    const profile = await resolveProfile(repositoryRoot, "fixture");
    const issues = await runProfilePreflightChecks(profile, {});
    expect(issues).toEqual([]);
  });
});
