import {
  runRepositoryPreflight,
  type VerificationIssue,
  type VerificationReport,
} from "../preflight/index.js";

export { runRepositoryPreflight };
export type { VerificationIssue, VerificationReport };

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

export async function verifyRepository(
  repositoryRoot: string,
  profileId: string,
): Promise<VerificationReport> {
  return runRepositoryPreflight(repositoryRoot, profileId);
}
