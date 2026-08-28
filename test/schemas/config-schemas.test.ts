import { describe, expect, it } from "vitest";
import {
  ChallengeConfigSchema,
  ContestantsConfigSchema,
  JudgesConfigSchema,
} from "../../src/schemas/index.js";

const challengeConfig = {
  schemaVersion: 1,
  seasonId: "0001",
  title: "Local Maxima",
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
