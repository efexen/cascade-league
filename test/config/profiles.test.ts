import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import {
  resolveProfile,
  validateProfileCrossChecks,
} from "../../src/config/profiles.js";
import {
  ContestantsConfigSchema,
  JudgesConfigSchema,
} from "../../src/schemas/index.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

function contestantsConfig(overrides: Record<string, unknown> = {}) {
  const fixtureEntry = (id: string) => ({
    id,
    displayName: `Contestant ${id}`,
    harness: {
      name: "fixture-harness",
      version: "1.0.0",
      adapter: "fixture",
      fixture: "editorial",
    },
    model: {
      provider: "local-fixture",
      name: `${id}-model`,
      version: "1.0.0",
    },
    enabled: true,
  });
  return {
    schemaVersion: 2,
    defaults: {
      timeoutMs: 60000,
      maximumTotalTokens: 1000,
      maximumSubmissionBytes: 61440,
      concurrency: 2,
    },
    contestants: [fixtureEntry("contestant-one"), fixtureEntry("contestant-two")],
    ...overrides,
  };
}

function judgesConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    defaults: {
      timeoutMs: 60000,
      maximumOutputTokens: 1000,
      concurrencyPerJudge: 1,
    },
    judges: [
      {
        id: "judge-one",
        displayName: "Judge One",
        harness: {
          name: "fixture-judge",
          version: "1.0.0",
          adapter: "fixture",
          fixture: "critic-a",
        },
        model: {
          provider: "local-fixture",
          name: "judge-one-model",
          version: "1.0.0",
        },
        enabled: true,
      },
    ],
    ...overrides,
  };
}

async function repositoryWithProfile(
  profileId: string,
  files: Record<string, unknown>,
): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "local-maxima-profile-repo-"));
  const profileRoot = join(parent, "config", "profiles", profileId);
  await mkdir(profileRoot, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(profileRoot, name), stringifyYaml(value), "utf8");
  }
  return parent;
}

describe("named configuration profiles", () => {
  it("resolves the checked-in fixture profile from the repository", async () => {
    const profile = await resolveProfile(repositoryRoot, "fixture");
    expect(profile.profileId).toBe("fixture");
    expect(profile.sourcePaths).toEqual({
      contestants: "config/profiles/fixture/contestants.yaml",
      judges: "config/profiles/fixture/judges.yaml",
    });
    expect(profile.contestants.contestants.map((entry) => entry.id)).toEqual([
      "fixture-editorial",
      "fixture-geometric",
      "fixture-generic",
    ]);
    expect(profile.judges.judges.map((entry) => entry.id)).toEqual([
      "fixture-critic-a",
      "fixture-critic-b",
    ]);
  });

  it("rejects malformed profile identifiers before any filesystem access", async () => {
    for (const profileId of [
      "",
      "..",
      "../outside",
      "a/b",
      "/absolute",
      "UPPER",
      "with space",
      "trailing-",
      "-leading",
      "under_score",
    ]) {
      await expect(
        resolveProfile("/nonexistent/repository/root", profileId),
      ).rejects.toThrow(/slug|profile identifier/i);
    }
  });

  it("accepts dot-separated lowercase slug segments and rejects malformed dotted forms", async () => {
    // The goal's required layout names the checked-in template profile
    // `real.example`, so a profile identifier is one or more dot-separated
    // SlugSchema segments. Every other identifier boundary still holds.
    for (const profileId of ["real.example", "real.local", "a.b-c"]) {
      const parent = await repositoryWithProfile(profileId, {
        "contestants.yaml": contestantsConfig(),
        "judges.yaml": judgesConfig(),
      });
      const profile = await resolveProfile(parent, profileId);
      expect(profile.profileId).toBe(profileId);
    }
    for (const profileId of [
      "real..local",
      ".hidden",
      "hidden.",
      "REAL.EXAMPLE",
      "real.example/",
      "one.two..three",
      ".",
    ]) {
      await expect(
        resolveProfile("/nonexistent/repository/root", profileId),
      ).rejects.toThrow(/slug|profile identifier/i);
    }
  });

  it("reports a missing profile directory by name", async () => {
    const parent = await mkdtemp(join(tmpdir(), "local-maxima-profile-empty-"));
    await expect(resolveProfile(parent, "absent")).rejects.toThrow(/absent/);
  });

  it("rejects a symlinked profile directory", async () => {
    const source = await repositoryWithProfile("real", {
      "contestants.yaml": contestantsConfig(),
      "judges.yaml": judgesConfig(),
    });
    const parent = await mkdtemp(join(tmpdir(), "local-maxima-profile-symlink-"));
    await mkdir(join(parent, "config", "profiles"), { recursive: true });
    await symlink(
      join(source, "config", "profiles", "real"),
      join(parent, "config", "profiles", "sneaky"),
    );
    await expect(resolveProfile(parent, "sneaky")).rejects.toThrow(/symlink/i);
  });

  it("rejects symlinked profile files", async () => {
    const parent = await repositoryWithProfile("mixed", {
      "contestants.yaml": contestantsConfig(),
      "judges.yaml": judgesConfig(),
    });
    const profileRoot = join(parent, "config", "profiles", "mixed");
    const outside = await mkdtemp(join(tmpdir(), "local-maxima-profile-outside-"));
    const outsideJudges = join(outside, "judges.yaml");
    await cp(join(profileRoot, "judges.yaml"), outsideJudges);
    await rm(join(profileRoot, "judges.yaml"));
    await symlink(outsideJudges, join(profileRoot, "judges.yaml"));
    await expect(resolveProfile(parent, "mixed")).rejects.toThrow(/symlink/i);
  });

  it("names the missing side when either YAML file is absent", async () => {
    const missingContestants = await repositoryWithProfile("only-judges", {
      "judges.yaml": judgesConfig(),
    });
    await expect(resolveProfile(missingContestants, "only-judges")).rejects.toThrow(
      /contestants\.yaml/,
    );
    const missingJudges = await repositoryWithProfile("only-contestants", {
      "contestants.yaml": contestantsConfig(),
    });
    await expect(resolveProfile(missingJudges, "only-contestants")).rejects.toThrow(
      /judges\.yaml/,
    );
  });

  it("returns parsed, normalised configs for a valid temporary profile", async () => {
    const parent = await repositoryWithProfile("temp", {
      "contestants.yaml": contestantsConfig(),
      "judges.yaml": judgesConfig(),
    });
    const profile = await resolveProfile(parent, "temp");
    expect(profile.sourcePaths).toEqual({
      contestants: "config/profiles/temp/contestants.yaml",
      judges: "config/profiles/temp/judges.yaml",
    });
    expect(profile.contestants.contestants).toHaveLength(2);
    expect(profile.judges.judges).toHaveLength(1);
  });

  it("resolves a profile assembled from the archived v1 configuration samples", async () => {
    const parent = await repositoryWithProfile("archived-v1", {});
    const profileRoot = join(parent, "config", "profiles", "archived-v1");
    for (const side of ["contestants", "judges"] as const) {
      await cp(
        new URL(`../fixtures/config-archive/v1/${side}.yaml`, import.meta.url).pathname,
        join(profileRoot, `${side}.yaml`),
      );
    }
    const profile = await resolveProfile(parent, "archived-v1");
    expect(profile.contestants.schemaVersion).toBe(1);
    expect(profile.judges.schemaVersion).toBe(1);
    expect(profile.contestants.resourceGroups).toBeUndefined();
    expect(profile.judges.resourceGroups).toBeUndefined();
    expect(profile.sourcePaths).toEqual({
      contestants: "config/profiles/archived-v1/contestants.yaml",
      judges: "config/profiles/archived-v1/judges.yaml",
    });
  });

  it("rejects invalid configuration inside a profile file", async () => {
    const parent = await repositoryWithProfile("broken", {
      "contestants.yaml": contestantsConfig({ unexpected: true }),
      "judges.yaml": judgesConfig(),
    });
    await expect(resolveProfile(parent, "broken")).rejects.toThrow();
  });

  it("git-ignores the operator real.local profile directory", async () => {
    const { readFile } = await import("node:fs/promises");
    const gitignore = await readFile(join(repositoryRoot, ".gitignore"), "utf8");
    expect(gitignore.split("\n")).toContain("config/profiles/real.local/");
  });

  it("rejects a resource group declared with conflicting definitions across files", () => {
    expect(() =>
      validateProfileCrossChecks({
        contestants: ContestantsConfigSchema.parse(
          contestantsConfig({
            resourceGroups: {
              lane: { maximumConcurrency: 2, minimumStartIntervalMs: 1000 },
            },
          }),
        ),
        judges: JudgesConfigSchema.parse(
          judgesConfig({
            resourceGroups: {
              lane: { maximumConcurrency: 2, minimumStartIntervalMs: 2000 },
            },
          }),
        ),
      }),
    ).toThrow(/lane/);
  });

  it("accepts identical shared resource-group definitions", () => {
    const shared = { lane: { maximumConcurrency: 2, minimumStartIntervalMs: 1000 } };
    expect(() =>
      validateProfileCrossChecks({
        contestants: ContestantsConfigSchema.parse(
          contestantsConfig({ resourceGroups: shared }),
        ),
        judges: JudgesConfigSchema.parse(judgesConfig({ resourceGroups: shared })),
      }),
    ).not.toThrow();
  });

  it("accepts disjoint resource-group declarations", () => {
    expect(() =>
      validateProfileCrossChecks({
        contestants: ContestantsConfigSchema.parse(
          contestantsConfig({
            resourceGroups: {
              "contestant-lane": { maximumConcurrency: 2, minimumStartIntervalMs: 0 },
            },
          }),
        ),
        judges: JudgesConfigSchema.parse(
          judgesConfig({
            resourceGroups: {
              "judge-lane": { maximumConcurrency: 1, minimumStartIntervalMs: 0 },
            },
          }),
        ),
      }),
    ).not.toThrow();
  });
});
