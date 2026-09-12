import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { chromium } from "playwright";
import sharp from "sharp";

import { loadSeasonDefinition } from "../challenge/index.js";
import { resolveProfile, type ResolvedProfile } from "../config/profiles.js";
import type {
  ContestantsConfig,
  ContestantConfig,
  JudgeConfig,
  JudgesConfig,
} from "../schemas/index.js";

export interface VerificationIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface VerificationReport {
  readonly ok: boolean;
  readonly issues: readonly VerificationIssue[];
}

function issue(
  code: string,
  message: string,
  severity: VerificationIssue["severity"] = "error",
): VerificationIssue {
  return { code, severity, message };
}

export type CommandProfileEntry =
  | (ContestantConfig & { harness: { adapter: "command" } })
  | (JudgeConfig & { harness: { adapter: "command" } });

function isCommandEntry(
  entry: ContestantConfig | JudgeConfig,
): entry is CommandProfileEntry {
  return entry.harness.adapter === "command";
}

export function enabledCommandEntries(profile: ResolvedProfile): CommandProfileEntry[] {
  return [
    ...profile.contestants.contestants.filter((contestant) => contestant.enabled),
    ...profile.judges.judges.filter((judge) => judge.enabled),
  ].filter(isCommandEntry);
}

/**
 * Profile-scoped preflight checks. These never execute any configured
 * command and never make a model call; they inspect the resolved profile
 * against the supplied operator environment only. The environment reader is
 * injectable so tests stay hermetic.
 */
export async function runProfilePreflightChecks(
  profile: ResolvedProfile,
  environment: NodeJS.ProcessEnv,
): Promise<VerificationIssue[]> {
  const issues: VerificationIssue[] = [];

  const enabledContestants = profile.contestants.contestants.filter(
    (contestant) => contestant.enabled,
  );
  const enabledJudges = profile.judges.judges.filter((judge) => judge.enabled);
  if (enabledContestants.length < 2 || enabledContestants.length > 6) {
    issues.push(
      issue(
        "enabled_roster",
        `profile "${profile.profileId}" has ${String(enabledContestants.length)} enabled contestant(s); at least two enabled and at most six enabled contestants are required`,
      ),
    );
  }
  if (enabledJudges.length < 1) {
    issues.push(
      issue(
        "enabled_roster",
        `profile "${profile.profileId}" has no enabled judge; at least one enabled judge is required`,
      ),
    );
  }

  for (const entry of enabledCommandEntries(profile)) {
    for (const name of entry.harness.command.environmentAllowlist) {
      if (environment[name] === undefined) {
        issues.push(
          issue(
            "environment_variable",
            `${entry.id} allowlisted environment variable ${name} is not present in the operator environment`,
          ),
        );
      }
    }
    for (const [index, value] of entry.harness.command.argv.entries()) {
      for (const match of value.matchAll(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
      )) {
        const name = match[1] ?? match[2]!;
        if (entry.harness.command.environmentAllowlist.includes(name)) {
          issues.push(
            issue(
              "environment_reference_not_expanded",
              `${entry.id} argv[${String(index)}] references environment variable ${name}, but commands run with shell: false so the reference is passed through unexpanded`,
              "warning",
            ),
          );
        } else {
          issues.push(
            issue(
              "environment_reference_outside_allowlist",
              `${entry.id} argv[${String(index)}] references environment variable ${name} which is not in the entry's environmentAllowlist`,
            ),
          );
        }
      }
    }
  }

  for (const contestant of profile.contestants.contestants) {
    if (!contestant.enabled || contestant.harness.adapter !== "command") continue;
    const argv = contestant.harness.command.argv;
    const missing: string[] = [];
    if (!argv.includes("{promptPath}")) missing.push("{promptPath}");
    if (!argv.includes("{submissionPath}")) missing.push("{submissionPath}");
    if (missing.length > 0) {
      issues.push(
        issue(
          "placeholder_compatibility",
          `contestant ${contestant.id} argv is missing required placeholder(s) ${missing.join(", ")}; the contestant command must be able to read the prompt and write submission.css`,
        ),
      );
    }
  }
  for (const judge of profile.judges.judges) {
    if (!judge.enabled || judge.harness.adapter !== "command") continue;
    const argv = judge.harness.command.argv;
    const missing: string[] = [];
    if (!argv.includes("{promptPath}")) missing.push("{promptPath}");
    if (!argv.includes("{judgmentPath}") && !argv.includes("{awardsPath}")) {
      missing.push("{judgmentPath} or {awardsPath}");
    }
    if (missing.length > 0) {
      issues.push(
        issue(
          "placeholder_compatibility",
          `judge ${judge.id} argv is missing required placeholder(s) ${missing.join(", ")}; the judge adapter aliases {judgmentPath} and {awardsPath} per operation`,
        ),
      );
    }
  }

  for (const contestant of profile.contestants.contestants) {
    if (!contestant.enabled || contestant.harness.adapter !== "command") continue;
    if (contestant.execution?.oneShotEnforcement === "prompt_only") {
      issues.push(
        issue(
          "one_shot_prompt_only",
          `contestant ${contestant.id} relies on prompt-only one-shot enforcement; the harness is not sandboxed against a second attempt`,
          "warning",
        ),
      );
    }
  }

  for (const entry of enabledCommandEntries(profile)) {
    const harnessVersion = entry.harness.version;
    if (harnessVersion === undefined || isGenericVersion(harnessVersion)) {
      issues.push(
        issue(
          "version_genericity",
          `${entry.id} harness.version must be present, non-blank, and not a generic placeholder (found ${JSON.stringify(harnessVersion ?? "")})`,
        ),
      );
    }
    if (isGenericVersion(entry.model.version)) {
      issues.push(
        issue(
          "version_genericity",
          `${entry.id} model.version must be present, non-blank, and not a generic placeholder (found ${JSON.stringify(entry.model.version)})`,
        ),
      );
    }
  }

  return issues;
}

const GENERIC_VERSION_DENYLIST = new Set([
  "latest",
  "record-at-run-time",
  "pinned-or-recorded",
  "current",
  "stable",
  "auto",
  "*",
]);

function isGenericVersion(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return GENERIC_VERSION_DENYLIST.has(trimmed.toLowerCase());
}

export interface RepositoryPreflightOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly seasonId?: string;
}

async function commandExecutables(
  issues: VerificationIssue[],
  contestants: ContestantsConfig,
  judges: JudgesConfig,
): Promise<void> {
  const commands = [
    ...contestants.contestants.filter((contestant) => contestant.enabled),
    ...judges.judges.filter((judge) => judge.enabled),
  ];
  for (const configured of commands) {
    if (configured.harness.adapter !== "command") {
      continue;
    }
    const executable = configured.harness.command.argv[0];
    if (executable === undefined) {
      continue;
    }
    try {
      await access(executable, fsConstants.X_OK);
    } catch {
      issues.push(
        issue(
          "command_executable",
          `${configured.id} executable is not available or executable: ${executable}`,
        ),
      );
    }
  }
}

/**
 * Node 24 is the reference runtime. The installed toolchain supports Node 22
 * and Node 24+, but not Node 23.
 */
export function isSupportedNodeMajor(nodeMajor: number): boolean {
  return nodeMajor === 22 || nodeMajor >= 24;
}

/**
 * The complete no-model-call preflight shared by `garden verify` and
 * `garden plan-generation`. It never executes a configured command and never
 * makes a model call.
 */
export async function runRepositoryPreflight(
  repositoryRoot: string,
  profileId: string,
  options: RepositoryPreflightOptions = {},
): Promise<VerificationReport> {
  const issues: VerificationIssue[] = [];
  const root = join(repositoryRoot);
  const environment = options.environment ?? process.env;
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!isSupportedNodeMajor(nodeMajor)) {
    issues.push(
      issue(
        "node_version",
        `Node 22.x or Node 24 and newer is required; running ${process.version}`,
      ),
    );
  } else if (nodeMajor !== 24) {
    issues.push(
      issue(
        "node_version",
        `Node 24.x is the reference runtime; Node.js 22.x and 24 or newer are supported (running ${process.version})`,
        "warning",
      ),
    );
  }

  let profile: ResolvedProfile | undefined;
  try {
    profile = await resolveProfile(root, profileId);
  } catch (error) {
    issues.push(
      issue(
        "profile_resolution",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  try {
    const seasonId = options.seasonId ?? "0001";
    const seasonDirectory = `season-${Number.parseInt(seasonId, 10)
      .toString()
      .padStart(3, "0")}`;
    const definition = await loadSeasonDefinition(
      join(root, "challenge", seasonDirectory),
    );
    const requiredFonts = [
      "lm-neutral-sans.ttf",
      "lm-display-sans.ttf",
      "lm-readable-serif.ttf",
      "lm-expressive-serif.ttf",
      "lm-mono.ttf",
    ];
    for (const font of requiredFonts) {
      try {
        await access(join(definition.rootPath, "fonts", font), fsConstants.R_OK);
      } catch {
        issues.push(issue("font_asset", `missing readable challenge font: ${font}`));
      }
    }
    if (definition.seed.entries.length !== 6) {
      issues.push(
        issue("seed_count", `Season ${seasonId} must contain exactly six seed entries`),
      );
    }
    await Promise.all(
      definition.seed.entries.map(async (entry) => {
        try {
          const metadata = await sharp(
            join(definition.rootPath, "seed", entry.screenshotPath),
          ).metadata();
          if (
            metadata.width !== definition.config.viewport.width ||
            metadata.height !== definition.config.viewport.height ||
            metadata.format !== "png"
          ) {
            issues.push(
              issue(
                "seed_asset",
                `${entry.id} is not a ${String(definition.config.viewport.width)}×${String(definition.config.viewport.height)} PNG`,
              ),
            );
          }
        } catch {
          issues.push(
            issue("seed_asset", `missing or unreadable seed thumbnail: ${entry.id}`),
          );
        }
      }),
    );
  } catch (error) {
    issues.push(
      issue("challenge_inputs", error instanceof Error ? error.message : String(error)),
    );
  }

  try {
    const executablePath = chromium.executablePath();
    await access(executablePath, fsConstants.X_OK);
  } catch {
    issues.push(
      issue(
        "playwright_chromium",
        "Playwright bundled Chromium is not installed or executable",
      ),
    );
  }

  if (profile !== undefined) {
    await commandExecutables(issues, profile.contestants, profile.judges);
    issues.push(...(await runProfilePreflightChecks(profile, environment)));
  }

  return {
    ok: issues.every((entry) => entry.severity !== "error"),
    issues,
  };
}
