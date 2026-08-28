import { describe, expect, it } from "vitest";
import {
  ChallengeConfigSchema,
  parseJsonWithSchema,
  parseYamlWithSchema,
} from "../../src/schemas/index.js";

const challenge = {
  schemaVersion: 1,
  seasonId: "0001",
  title: "Local Maxima",
  challengeVersion: "1.0.0",
  template: "challenge.hbs",
  starterCss: "starter.css",
  fallbackCss: "fallback.css",
  seedData: "seed/seed-generation.json",
  viewport: { width: 1440, height: 1200, deviceScaleFactor: 1 },
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
  requiredSelectors: ["#masthead"],
} as const;

describe("schema-aware document parsing", () => {
  it("parses YAML and JSON only after applying the supplied Zod schema", () => {
    const yaml = Object.entries(challenge)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");
    expect(parseYamlWithSchema(yaml, ChallengeConfigSchema)).toMatchObject({
      seasonId: "0001",
    });
    expect(
      parseJsonWithSchema(JSON.stringify(challenge), ChallengeConfigSchema),
    ).toEqual(challenge);
  });

  it("surfaces malformed documents and schema violations", () => {
    expect(() => parseJsonWithSchema("{not-json}", ChallengeConfigSchema)).toThrow(
      /Invalid JSON/,
    );
    expect(() =>
      parseYamlWithSchema("schemaVersion: 1\nseasonId: nope", ChallengeConfigSchema),
    ).toThrow();
  });
});
