import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  ChallengeConfigSchema,
  ContestantsConfigSchema,
  JudgesConfigSchema,
  ProfileJsonSchema,
  readYamlWithSchema,
} from "../../src/schemas/index.js";

const challengeConfig = {
  schemaVersion: 1,
  seasonId: "0001",
  title: "Cascade League",
  challengeVersion: "1.0.0",
  template: "challenge.hbs",
  starterCss: "starter.css",
  fallbackCss: "fallback.css",
  seedData: "seed/seed-generation.json",
  viewport: {
    width: 1440,
    height: 1200,
    deviceScaleFactor: 1,
  },
  browser: {
    engine: "chromium",
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-GB",
    timezoneId: "UTC",
    javaScriptEnabled: false,
  },
  submission: {
    filename: "submission.css",
    maximumBytes: 61440,
    allowImports: false,
    allowRemoteUrls: false,
    allowDataUrls: false,
  },
  requiredSelectors: ["#masthead", "#leaderboard", ".entry-card"],
} as const;

const commandHarness = {
  name: "fixture-harness",
  version: "1.0.0",
  adapter: "command",
  command: {
    argv: ["/usr/bin/env", "node", "{promptPath}", "{submissionPath}"],
    environmentAllowlist: ["FIXTURE_TOKEN"],
  },
} as const;

const contestant = {
  id: "fixture-harness-fixture-model",
  displayName: "Fixture Harness + Fixture Model",
  harness: commandHarness,
  model: {
    provider: "fixture-provider",
    name: "fixture-model",
    version: "1.0.0",
    reasoningEffort: "medium",
  },
  budget: {
    timeoutMs: 480000,
    maximumTotalTokens: 30000,
  },
  enabled: true,
} as const;

const judge = {
  id: "fixture-judge",
  displayName: "Fixture Judge",
  harness: {
    name: "fixture-harness",
    adapter: "command",
    command: {
      argv: [
        "/usr/bin/env",
        "node",
        "{promptPath}",
        "{candidateScreenshotPath}",
        "{contactSheetPath}",
        "{sanitisedCssPath}",
        "{judgmentPath}",
      ],
      environmentAllowlist: [],
    },
  },
  model: {
    provider: "fixture-provider",
    name: "fixture-vision-model",
    version: "1.0.0",
  },
  budget: {
    timeoutMs: 180000,
    maximumOutputTokens: 4000,
  },
  enabled: true,
} as const;

describe("configuration schemas", () => {
  it("accepts the documented challenge, contestant, and judge shapes", () => {
    expect(ChallengeConfigSchema.parse(challengeConfig)).toEqual(challengeConfig);
    expect(
      ContestantsConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 480000,
          maximumTotalTokens: 30000,
          maximumSubmissionBytes: 61440,
          concurrency: 4,
        },
        contestants: [contestant, { ...contestant, id: "second-contestant" }],
      }),
    ).toBeTruthy();
    expect(
      JudgesConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 180000,
          maximumOutputTokens: 4000,
          concurrencyPerJudge: 2,
        },
        judges: [judge],
      }),
    ).toBeTruthy();
  });

  it("rejects unknown keys at every configuration boundary", () => {
    expect(() =>
      ChallengeConfigSchema.parse({ ...challengeConfig, unexpected: true }),
    ).toThrow();
    expect(() =>
      ContestantsConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 480000,
          maximumTotalTokens: 30000,
          maximumSubmissionBytes: 61440,
          concurrency: 4,
        },
        contestants: [
          {
            ...contestant,
            model: { ...contestant.model, unexpected: "nope" },
          },
          { ...contestant, id: "second-contestant" },
        ],
      }),
    ).toThrow();
  });

  it("rejects malformed IDs, duplicate IDs, unsafe paths, and invalid budgets", () => {
    expect(() =>
      ChallengeConfigSchema.parse({ ...challengeConfig, seasonId: "1" }),
    ).toThrow();
    expect(() =>
      ChallengeConfigSchema.parse({
        ...challengeConfig,
        viewport: { ...challengeConfig.viewport, width: 1024 },
      }),
    ).toThrow();
    expect(() =>
      ContestantsConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: -1,
          maximumTotalTokens: 30000,
          maximumSubmissionBytes: 61440,
          concurrency: 4,
        },
        contestants: [contestant, { ...contestant, id: "second-contestant" }],
      }),
    ).toThrow();
    expect(() =>
      ContestantsConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 480000,
          maximumTotalTokens: 30000,
          maximumSubmissionBytes: 61440,
          concurrency: 4,
        },
        contestants: [contestant, { ...contestant, id: contestant.id }],
      }),
    ).toThrow();
    expect(() =>
      ChallengeConfigSchema.parse({ ...challengeConfig, template: "../secret.hbs" }),
    ).toThrow();
    expect(() =>
      ContestantsConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 480000,
          maximumTotalTokens: 30000,
          maximumSubmissionBytes: 61441,
          concurrency: 4,
        },
        contestants: [contestant, { ...contestant, id: "second-contestant" }],
      }),
    ).toThrow();
  });

  it("accepts modern reasoning effort values in contestant configuration", () => {
    expect(
      ContestantsConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 480000,
          maximumTotalTokens: 30000,
          maximumSubmissionBytes: 61440,
          concurrency: 4,
        },
        contestants: [
          {
            ...contestant,
            model: { ...contestant.model, reasoningEffort: "max" },
          },
          { ...contestant, id: "second-contestant" },
        ],
      }),
    ).toBeTruthy();
  });

  it("requires two to six declared contestants", () => {
    const config = {
      schemaVersion: 1,
      defaults: {
        timeoutMs: 480000,
        maximumTotalTokens: 30000,
        maximumSubmissionBytes: 61440,
        concurrency: 4,
      },
      contestants: [contestant],
    };

    expect(() => ContestantsConfigSchema.parse(config)).toThrow();
  });

  it("accepts the execution metadata output placeholder as a complete contestant argv value", () => {
    expect(() =>
      ContestantsConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 480000,
          maximumTotalTokens: 30000,
          maximumSubmissionBytes: 61440,
          concurrency: 4,
        },
        contestants: [
          {
            ...contestant,
            harness: {
              ...commandHarness,
              command: {
                ...commandHarness.command,
                argv: [
                  "/usr/bin/env",
                  "node",
                  "{promptPath}",
                  "{submissionPath}",
                  "{usageOutputPath}",
                  "{executionMetadataOutputPath}",
                ],
              },
            },
          },
          { ...contestant, id: "second-contestant" },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts the execution metadata output placeholder as a complete judge argv value", () => {
    expect(() =>
      JudgesConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 180000,
          maximumOutputTokens: 4000,
          concurrencyPerJudge: 2,
        },
        judges: [
          {
            ...judge,
            harness: {
              ...judge.harness,
              command: {
                ...judge.harness.command,
                argv: [...judge.harness.command.argv, "{executionMetadataOutputPath}"],
              },
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects embedded or partial execution metadata templating", () => {
    for (const embedded of [
      "--metadata={executionMetadataOutputPath}",
      "{executionMetadataOutputPath}.json",
      "{executionMetadataOutputPath}{submissionPath}",
    ]) {
      expect(() =>
        ContestantsConfigSchema.parse({
          schemaVersion: 1,
          defaults: {
            timeoutMs: 480000,
            maximumTotalTokens: 30000,
            maximumSubmissionBytes: 61440,
            concurrency: 4,
          },
          contestants: [
            {
              ...contestant,
              harness: {
                ...commandHarness,
                command: {
                  ...commandHarness.command,
                  argv: ["/usr/bin/env", embedded],
                },
              },
            },
            { ...contestant, id: "second-contestant" },
          ],
        }),
      ).toThrow(/placeholder/i);
    }
    expect(() =>
      JudgesConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 180000,
          maximumOutputTokens: 4000,
          concurrencyPerJudge: 2,
        },
        judges: [
          {
            ...judge,
            harness: {
              ...judge.harness,
              command: {
                ...judge.harness.command,
                argv: ["/usr/bin/env", "--metadata={executionMetadataOutputPath}"],
              },
            },
          },
        ],
      }),
    ).toThrow(/placeholder/i);
  });

  it("requires absolute executables and complete known placeholders", () => {
    expect(() =>
      ContestantsConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 480000,
          maximumTotalTokens: 30000,
          maximumSubmissionBytes: 61440,
          concurrency: 4,
        },
        contestants: [
          {
            ...contestant,
            harness: {
              ...commandHarness,
              command: { ...commandHarness.command, argv: ["node", "{promptPath}"] },
            },
          },
          { ...contestant, id: "second-contestant" },
        ],
      }),
    ).toThrow();
    expect(() =>
      ContestantsConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 480000,
          maximumTotalTokens: 30000,
          maximumSubmissionBytes: 61440,
          concurrency: 4,
        },
        contestants: [
          {
            ...contestant,
            harness: {
              ...commandHarness,
              command: {
                ...commandHarness.command,
                argv: ["/usr/bin/env", "{unknownPath}"],
              },
            },
          },
          { ...contestant, id: "second-contestant" },
        ],
      }),
    ).toThrow();
    expect(() =>
      ContestantsConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 480000,
          maximumTotalTokens: 30000,
          maximumSubmissionBytes: 61440,
          concurrency: 4,
        },
        contestants: [
          {
            ...contestant,
            harness: {
              ...commandHarness,
              command: {
                ...commandHarness.command,
                argv: ["/usr/bin/env", "node", "safe && unsafe"],
              },
            },
          },
          { ...contestant, id: "second-contestant" },
        ],
      }),
    ).toThrow();
  });

  it("allows the judge usage output placeholder in the shared command contract", () => {
    const judgeWithUsage = {
      ...judge,
      harness: {
        ...judge.harness,
        command: {
          ...judge.harness.command,
          argv: [...judge.harness.command.argv, "{usageOutputPath}"],
        },
      },
    };
    expect(
      JudgesConfigSchema.parse({
        schemaVersion: 1,
        defaults: {
          timeoutMs: 180000,
          maximumOutputTokens: 4000,
          concurrencyPerJudge: 2,
        },
        judges: [judgeWithUsage],
      }),
    ).toBeTruthy();
  });

  it("rejects contestant-only paths in judge command configuration", () => {
    for (const forbiddenPlaceholder of [
      "{challengePath}",
      "{starterCssPath}",
      "{submissionPath}",
    ]) {
      expect(() =>
        JudgesConfigSchema.parse({
          schemaVersion: 1,
          defaults: {
            timeoutMs: 180000,
            maximumOutputTokens: 4000,
            concurrencyPerJudge: 2,
          },
          judges: [
            {
              ...judge,
              harness: {
                ...judge.harness,
                command: {
                  ...judge.harness.command,
                  argv: ["/usr/bin/env", forbiddenPlaceholder],
                },
              },
            },
          ],
        }),
      ).toThrow();
    }
  });

  it("caps configured concurrency at four contestants and two assessments per judge", () => {
    const contestantsConfig = {
      schemaVersion: 1,
      defaults: {
        timeoutMs: 480000,
        maximumTotalTokens: 30000,
        maximumSubmissionBytes: 61440,
        concurrency: 5,
      },
      contestants: [contestant, { ...contestant, id: "second-contestant" }],
    };
    const judgesConfig = {
      schemaVersion: 1,
      defaults: {
        timeoutMs: 180000,
        maximumOutputTokens: 4000,
        concurrencyPerJudge: 3,
      },
      judges: [judge],
    };

    expect(() => ContestantsConfigSchema.parse(contestantsConfig)).toThrow();
    expect(() => JudgesConfigSchema.parse(judgesConfig)).toThrow();
  });
});

const contestantsDefaults = {
  timeoutMs: 480000,
  maximumTotalTokens: 30000,
  maximumSubmissionBytes: 61440,
  concurrency: 4,
} as const;

const judgesDefaults = {
  timeoutMs: 180000,
  maximumOutputTokens: 4000,
  concurrencyPerJudge: 2,
} as const;

function contestantsConfigV2(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    defaults: contestantsDefaults,
    contestants: [contestant, { ...contestant, id: "second-contestant" }],
    ...overrides,
  };
}

function judgesConfigV2(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    defaults: judgesDefaults,
    judges: [judge],
    ...overrides,
  };
}

describe("versioned run configuration (schemaVersion 1 and 2)", () => {
  it("accepts schemaVersion 1 and 2 and rejects every other version", () => {
    expect(() =>
      ContestantsConfigSchema.parse({
        schemaVersion: 2,
        defaults: contestantsDefaults,
        contestants: [contestant, { ...contestant, id: "second-contestant" }],
      }),
    ).not.toThrow();
    expect(() =>
      JudgesConfigSchema.parse({
        schemaVersion: 2,
        defaults: judgesDefaults,
        judges: [judge],
      }),
    ).not.toThrow();
    expect(() =>
      ContestantsConfigSchema.parse(contestantsConfigV2({ schemaVersion: 3 })),
    ).toThrow();
    expect(() =>
      ContestantsConfigSchema.parse(contestantsConfigV2({ schemaVersion: 0 })),
    ).toThrow();
    expect(() =>
      JudgesConfigSchema.parse(judgesConfigV2({ schemaVersion: 3 })),
    ).toThrow();
    expect(() =>
      JudgesConfigSchema.parse(judgesConfigV2({ schemaVersion: "2" })),
    ).toThrow();
  });

  it("accepts resource groups with role-dependent concurrency and shared interval bounds", () => {
    expect(() =>
      ContestantsConfigSchema.parse(
        contestantsConfigV2({
          resourceGroups: {
            "fast-lane": { maximumConcurrency: 4, minimumStartIntervalMs: 0 },
            "slow-lane": { maximumConcurrency: 1, minimumStartIntervalMs: 60000 },
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      JudgesConfigSchema.parse(
        judgesConfigV2({
          resourceGroups: {
            "judge-lane": { maximumConcurrency: 2, minimumStartIntervalMs: 1500 },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects resource groups outside the role-dependent bounds or with unknown keys", () => {
    for (const maximumConcurrency of [0, 5, 2.5]) {
      expect(() =>
        ContestantsConfigSchema.parse(
          contestantsConfigV2({
            resourceGroups: { lane: { maximumConcurrency, minimumStartIntervalMs: 0 } },
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      JudgesConfigSchema.parse(
        judgesConfigV2({
          resourceGroups: {
            lane: { maximumConcurrency: 3, minimumStartIntervalMs: 0 },
          },
        }),
      ),
    ).toThrow();
    for (const minimumStartIntervalMs of [-1, 60001, 12.5]) {
      expect(() =>
        ContestantsConfigSchema.parse(
          contestantsConfigV2({
            resourceGroups: {
              lane: { maximumConcurrency: 2, minimumStartIntervalMs },
            },
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      ContestantsConfigSchema.parse(
        contestantsConfigV2({
          resourceGroups: {
            lane: {
              maximumConcurrency: 2,
              minimumStartIntervalMs: 0,
              unexpected: true,
            },
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      ContestantsConfigSchema.parse(
        contestantsConfigV2({
          resourceGroups: {
            "Not A Slug": { maximumConcurrency: 2, minimumStartIntervalMs: 0 },
          },
        }),
      ),
    ).toThrow();
  });

  it("accepts per-entry execution declarations on both roles", () => {
    expect(() =>
      ContestantsConfigSchema.parse(
        contestantsConfigV2({
          resourceGroups: {
            lane: { maximumConcurrency: 2, minimumStartIntervalMs: 1000 },
          },
          contestants: [
            {
              ...contestant,
              execution: { resourceGroup: "lane", oneShotEnforcement: "enforced" },
            },
            {
              ...contestant,
              id: "second-contestant",
              execution: { resourceGroup: "lane", oneShotEnforcement: "prompt_only" },
            },
          ],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      JudgesConfigSchema.parse(
        judgesConfigV2({
          resourceGroups: {
            lane: { maximumConcurrency: 1, minimumStartIntervalMs: 0 },
          },
          judges: [
            {
              ...judge,
              execution: { resourceGroup: "lane", oneShotEnforcement: "prompt_only" },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects malformed execution blocks", () => {
    for (const oneShotEnforcement of ["best_effort", "ENFORCED", ""]) {
      expect(() =>
        ContestantsConfigSchema.parse(
          contestantsConfigV2({
            resourceGroups: {
              lane: { maximumConcurrency: 2, minimumStartIntervalMs: 0 },
            },
            contestants: [
              {
                ...contestant,
                execution: { resourceGroup: "lane", oneShotEnforcement },
              },
              { ...contestant, id: "second-contestant" },
            ],
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      ContestantsConfigSchema.parse(
        contestantsConfigV2({
          contestants: [
            {
              ...contestant,
              execution: { resourceGroup: "lane", oneShotEnforcement: "enforced" },
            },
            { ...contestant, id: "second-contestant" },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      ContestantsConfigSchema.parse(
        contestantsConfigV2({
          resourceGroups: {
            lane: { maximumConcurrency: 2, minimumStartIntervalMs: 0 },
          },
          contestants: [
            {
              ...contestant,
              execution: {
                resourceGroup: "lane",
                oneShotEnforcement: "enforced",
                unexpected: 1,
              },
            },
            { ...contestant, id: "second-contestant" },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      ContestantsConfigSchema.parse(
        contestantsConfigV2({
          resourceGroups: {
            lane: { maximumConcurrency: 2, minimumStartIntervalMs: 0 },
          },
          contestants: [
            { ...contestant, execution: { oneShotEnforcement: "enforced" } },
            { ...contestant, id: "second-contestant" },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects enabled command entries referencing an undeclared resource group", () => {
    expect(() =>
      ContestantsConfigSchema.parse(
        contestantsConfigV2({
          resourceGroups: {
            lane: { maximumConcurrency: 2, minimumStartIntervalMs: 0 },
          },
          contestants: [
            {
              ...contestant,
              execution: {
                resourceGroup: "missing-lane",
                oneShotEnforcement: "enforced",
              },
            },
            { ...contestant, id: "second-contestant" },
          ],
        }),
      ),
    ).toThrow(/missing-lane/);
    expect(() =>
      JudgesConfigSchema.parse(
        judgesConfigV2({
          judges: [
            {
              ...judge,
              execution: { resourceGroup: "ghost", oneShotEnforcement: "prompt_only" },
            },
          ],
        }),
      ),
    ).toThrow(/ghost/);
  });

  it("allows fixture entries to omit execution and leaves disabled entries unchecked", () => {
    const fixtureContestant = {
      ...contestant,
      harness: {
        name: "fixture-harness",
        version: "1.0.0",
        adapter: "fixture",
        fixture: "editorial",
      },
    };
    expect(() =>
      ContestantsConfigSchema.parse(
        contestantsConfigV2({
          contestants: [
            fixtureContestant,
            { ...fixtureContestant, id: "second-contestant" },
          ],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      ContestantsConfigSchema.parse(
        contestantsConfigV2({
          contestants: [
            {
              ...contestant,
              enabled: false,
              execution: { resourceGroup: "missing", oneShotEnforcement: "enforced" },
            },
            { ...contestant, id: "second-contestant" },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("normalises v1 documents without resource-group or execution fields", () => {
    const parsed = ContestantsConfigSchema.parse({
      schemaVersion: 1,
      defaults: contestantsDefaults,
      contestants: [contestant, { ...contestant, id: "second-contestant" }],
    });
    expect(parsed).toEqual({
      schemaVersion: 1,
      defaults: contestantsDefaults,
      contestants: [contestant, { ...contestant, id: "second-contestant" }],
    });
    expect(parsed.resourceGroups).toBeUndefined();
    expect(parsed.contestants[0]?.execution).toBeUndefined();
    expect("resourceGroups" in parsed).toBe(false);
    expect("execution" in (parsed.contestants[0] ?? {})).toBe(false);

    const parsedJudges = JudgesConfigSchema.parse({
      schemaVersion: 1,
      defaults: judgesDefaults,
      judges: [judge],
    });
    expect(parsedJudges.resourceGroups).toBeUndefined();
    expect(parsedJudges.judges[0]?.execution).toBeUndefined();
  });

  it("validates the profile.json artifact shape", () => {
    const profileJson = {
      schemaVersion: 1,
      profileId: "fixture",
      sourcePaths: {
        contestants: "config/profiles/fixture/contestants.yaml",
        judges: "config/profiles/fixture/judges.yaml",
      },
    };
    expect(ProfileJsonSchema.parse(profileJson)).toEqual(profileJson);
    expect(() =>
      ProfileJsonSchema.parse({ ...profileJson, unexpected: true }),
    ).toThrow();
    expect(() =>
      ProfileJsonSchema.parse({ ...profileJson, profileId: "Not/Allowed" }),
    ).toThrow();
    expect(() =>
      ProfileJsonSchema.parse({
        ...profileJson,
        sourcePaths: {
          contestants: "/absolute/contestants.yaml",
          judges: "config/profiles/fixture/judges.yaml",
        },
      }),
    ).toThrow();
    expect(() =>
      ProfileJsonSchema.parse({
        ...profileJson,
        sourcePaths: { contestants: "config/profiles/fixture/contestants.yaml" },
      }),
    ).toThrow();
    expect(() =>
      ProfileJsonSchema.parse({ ...profileJson, schemaVersion: 2 }),
    ).toThrow();
  });

  it("reads the archived v1 run-configuration samples and normalises them", async () => {
    const archivedContestantsPath = new URL(
      "../fixtures/config-archive/v1/contestants.yaml",
      import.meta.url,
    ).pathname;
    const archivedJudgesPath = new URL(
      "../fixtures/config-archive/v1/judges.yaml",
      import.meta.url,
    ).pathname;

    // The archived documents themselves are plain v1: no v2-only keys on disk.
    const rawContestants = parseYaml(
      await readFile(archivedContestantsPath, "utf8"),
    ) as Record<string, unknown>;
    const rawJudges = parseYaml(await readFile(archivedJudgesPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(rawContestants.schemaVersion).toBe(1);
    expect(rawJudges.schemaVersion).toBe(1);
    expect("resourceGroups" in rawContestants).toBe(false);
    expect("resourceGroups" in rawJudges).toBe(false);

    // The same tolerant read path used by profile resolution accepts them and
    // normalises them without inventing v2 fields.
    const contestants = await readYamlWithSchema(
      archivedContestantsPath,
      ContestantsConfigSchema,
    );
    const judges = await readYamlWithSchema(archivedJudgesPath, JudgesConfigSchema);
    expect(contestants.schemaVersion).toBe(1);
    expect(judges.schemaVersion).toBe(1);
    expect(contestants.resourceGroups).toBeUndefined();
    expect(judges.resourceGroups).toBeUndefined();
    for (const contestant of contestants.contestants) {
      expect("execution" in contestant).toBe(false);
    }
    for (const judgeEntry of judges.judges) {
      expect("execution" in judgeEntry).toBe(false);
    }

    // Normalisation must not mutate the on-disk documents.
    expect(parseYaml(await readFile(archivedContestantsPath, "utf8"))).toEqual(
      rawContestants,
    );
    expect(parseYaml(await readFile(archivedJudgesPath, "utf8"))).toEqual(rawJudges);
  });
});
