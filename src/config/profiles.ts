import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ContestantsConfigSchema,
  JudgesConfigSchema,
  ProfileIdSchema,
  readYamlWithSchema,
  type ContestantsConfig,
  type JudgesConfig,
} from "../schemas/index.js";

export const PROFILES_RELATIVE_DIRECTORY = "config/profiles";

export interface ProfileSourcePaths {
  readonly contestants: string;
  readonly judges: string;
}

export interface ResolvedProfile {
  readonly profileId: string;
  readonly directoryPath: string;
  readonly sourcePaths: ProfileSourcePaths;
  readonly contestantsPath: string;
  readonly judgesPath: string;
  readonly contestants: ContestantsConfig;
  readonly judges: JudgesConfig;
}

interface ResourceGroupDeclaration {
  readonly maximumConcurrency: number;
  readonly minimumStartIntervalMs: number;
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function profileFileLabel(profileId: string, side: "contestants" | "judges"): string {
  return `config/profiles/${profileId}/${side}.yaml`;
}

async function requireRegularFile(path: string, description: string): Promise<void> {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${description} is missing: ${path}`);
    }
    throw error;
  }
  if (status.isSymbolicLink()) {
    throw new Error(`${description} must not be a symlink: ${path}`);
  }
  if (!status.isFile()) {
    throw new Error(`${description} must be a regular file: ${path}`);
  }
}

/**
 * Validates the profile identifier as one or more dot-separated lowercase
 * hyphenated slug segments (`fixture`, `real.example`, `real.local`) and
 * resolves the two configuration files under
 * `config/profiles/<profileId>/` without following symlinks or leaving the
 * profiles directory. Both files are parsed with the tolerant
 * schemaVersion 1/2 run-configuration schemas and cross-checked.
 */
export async function resolveProfile(
  repositoryRoot: string,
  profileId: string,
): Promise<ResolvedProfile> {
  // Reject malformed, empty, separator-bearing, or traversal identifiers
  // before touching the filesystem.
  try {
    ProfileIdSchema.parse(profileId);
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`profile identifier is invalid${reason}`, { cause: error });
  }

  const root = resolve(repositoryRoot);
  const profilesRoot = join(root, ...PROFILES_RELATIVE_DIRECTORY.split("/"));
  const directoryPath = join(profilesRoot, profileId);
  if (!isContainedPath(profilesRoot, directoryPath)) {
    throw new Error(
      `profile "${profileId}" must resolve inside ${PROFILES_RELATIVE_DIRECTORY}/`,
    );
  }

  let directoryStatus;
  try {
    directoryStatus = await lstat(directoryPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `profile "${profileId}" does not exist: ${PROFILES_RELATIVE_DIRECTORY}/${profileId}/ is missing`,
      );
    }
    throw error;
  }
  if (directoryStatus.isSymbolicLink()) {
    throw new Error(
      `profile "${profileId}" must not be a symlinked directory: ${directoryPath}`,
    );
  }
  if (!directoryStatus.isDirectory()) {
    throw new Error(`profile "${profileId}" must be a directory: ${directoryPath}`);
  }

  const contestantsPath = join(directoryPath, "contestants.yaml");
  const judgesPath = join(directoryPath, "judges.yaml");
  await requireRegularFile(
    contestantsPath,
    `profile "${profileId}" contestants configuration`,
  );
  await requireRegularFile(judgesPath, `profile "${profileId}" judges configuration`);

  const [contestants, judges] = await Promise.all([
    readYamlWithSchema(contestantsPath, ContestantsConfigSchema),
    readYamlWithSchema(judgesPath, JudgesConfigSchema),
  ]);

  const profile: ResolvedProfile = {
    profileId,
    directoryPath,
    sourcePaths: {
      contestants: profileFileLabel(profileId, "contestants"),
      judges: profileFileLabel(profileId, "judges"),
    },
    contestantsPath,
    judgesPath,
    contestants,
    judges,
  };
  validateProfileCrossChecks(profile);
  return profile;
}

/**
 * A named resource group may be declared in both profile files only when the
 * declarations are identical. Duplicate keys inside a single YAML map are a
 * parser-level ambiguity, so the cross-file equality check is the enforced
 * interpretation of "conflicting definitions of a named resource group".
 */
export function validateProfileCrossChecks(input: {
  readonly contestants: {
    readonly resourceGroups?: Record<string, ResourceGroupDeclaration> | undefined;
  };
  readonly judges: {
    readonly resourceGroups?: Record<string, ResourceGroupDeclaration> | undefined;
  };
}): void {
  const contestantGroups = input.contestants.resourceGroups ?? {};
  const judgeGroups = input.judges.resourceGroups ?? {};
  for (const [name, declaration] of Object.entries(contestantGroups)) {
    const other = judgeGroups[name];
    if (other === undefined) continue;
    if (
      other.maximumConcurrency !== declaration.maximumConcurrency ||
      other.minimumStartIntervalMs !== declaration.minimumStartIntervalMs
    ) {
      throw new Error(
        `resource group "${name}" is declared with conflicting definitions across the profile files`,
      );
    }
  }
}

/**
 * Lists the checked-in profile directory names for operator messages. Only
 * real (non-symlink) directories count as profiles.
 */
export async function listCheckedInProfiles(repositoryRoot: string): Promise<string[]> {
  const profilesRoot = join(
    resolve(repositoryRoot),
    ...PROFILES_RELATIVE_DIRECTORY.split("/"),
  );
  let entries;
  try {
    entries = await readdir(profilesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const profiles: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const status = await lstat(join(profilesRoot, entry.name)).catch(() => undefined);
    if (status === undefined || status.isSymbolicLink() || !status.isDirectory()) {
      continue;
    }
    profiles.push(entry.name);
  }
  return profiles.sort();
}
