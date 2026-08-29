import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";
import sharp from "sharp";

import { loadSeasonDefinition } from "../challenge/index.js";
import { resolveProfile } from "../config/profiles.js";
import { type ContestantsConfig, type JudgesConfig } from "../schemas/index.js";

export function normalizeSeasonId(value: string): string {
  if (/^\d{3}$/.test(value)) {
    return `0${value}`;
  }
  if (/^\d{4}$/.test(value)) {
    return value;
  }
  throw new Error("season must be a three-digit CLI alias or a four-digit ID");
}

export function normalizeGenerationId(value: string): string {
  if (!/^\d{4}$/.test(value)) {
    throw new Error("generation must be a four-digit ID");
  }
  return value;
}

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

export async function verifyRepository(
  repositoryRoot: string,
  profileId: string,
): Promise<VerificationReport> {
  const issues: VerificationIssue[] = [];
  const root = join(repositoryRoot);
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (nodeMajor < 22) {
    issues.push(
      issue("node_version", `Node 22 or newer is required; running ${process.version}`),
    );
  } else if (nodeMajor !== 24) {
    issues.push(
      issue(
        "node_version",
        `Node 24.x is the reference runtime; compatible Node.js >=22 is supported (running ${process.version})`,
        "warning",
      ),
    );
  }

  let contestants: ContestantsConfig | undefined;
  let judges: JudgesConfig | undefined;
  try {
    const profile = await resolveProfile(root, profileId);
    contestants = profile.contestants;
    judges = profile.judges;
  } catch (error) {
    issues.push(
      issue(
        "profile_resolution",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  try {
    const definition = await loadSeasonDefinition(join(root, "challenge/season-001"));
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
        issue("seed_count", "Season 1 must contain exactly six seed entries"),
      );
    }
    await Promise.all(
      definition.seed.entries.map(async (entry) => {
        try {
          const metadata = await sharp(
            join(definition.rootPath, "seed", entry.screenshotPath),
          ).metadata();
          if (
            metadata.width !== 1440 ||
            metadata.height !== 1200 ||
            metadata.format !== "png"
          ) {
            issues.push(issue("seed_asset", `${entry.id} is not a 1440×1200 PNG`));
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

  if (contestants !== undefined && judges !== undefined) {
    await commandExecutables(issues, contestants, judges);
  }

  return {
    ok: issues.every((entry) => entry.severity !== "error"),
    issues,
  };
}
