import { copyFile, mkdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type {
  ContestantAdapter,
  ContestantRunInput,
  ContestantRunResult,
} from "./types.js";
import {
  emptyExecutionMetadata,
  emptyUsage,
  readExecutionMetadataFile,
  regularFileExists,
  resultWithError,
  writeLog,
  writeTextAtomically,
  type ExecutionMetadata,
} from "./support.js";

export interface FixtureContestantAdapterOptions {
  readonly fixtureRoot: string;
  readonly delayMs?: number;
}

type FixtureOutcome = "success" | "no_submission" | "failure" | "timeout";

function fixtureOutcome(fixture: string): FixtureOutcome {
  const normalised = fixture.toLowerCase().replaceAll("-", "_");
  if (["no_submission", "missing", "missing_submission", "none"].includes(normalised)) {
    return "no_submission";
  }
  if (["failure", "failed", "process_failure"].includes(normalised)) {
    return "failure";
  }
  if (["timeout", "timed_out"].includes(normalised)) {
    return "timeout";
  }
  return "success";
}

function fixturePath(root: string, fixture: string): string {
  const filename = fixture.endsWith(".css") ? fixture : `${fixture}.css`;
  const rootPath = resolve(root);
  const path = resolve(rootPath, filename);
  const child = relative(rootPath, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error("fixture stylesheet must remain within the fixture root");
  }
  return path;
}

// Deterministic, offline execution metadata written by the fixture wrapper so
// the fixture tournament exercises metadata reading, archival, observed-version
// recording, summary completeness, and public-leakage checks end to end. It is
// fully deterministic: no randomness, no clock, and no fabricated usage.
function fixtureExecutionMetadata(contestantId: string): ExecutionMetadata {
  return {
    observedHarnessVersion: "fixture-harness-1.0.0",
    observedModelVersion: "fixture-model-1.0.0",
    providerRequestId: `fixture-request-contestant-${contestantId}`,
  };
}

async function writeFixtureMetadata(
  input: ContestantRunInput,
): Promise<ExecutionMetadata> {
  const metadata = fixtureExecutionMetadata(input.contestantId);
  await writeTextAtomically(
    input.executionMetadataOutputPath,
    `${JSON.stringify({ schemaVersion: 1, ...metadata })}\n`,
  );
  const readBack = await readExecutionMetadataFile(input.executionMetadataOutputPath);
  return readBack.error === null ? readBack.metadata : emptyExecutionMetadata();
}

function observedVersionsOf(metadata: ExecutionMetadata): {
  readonly harness: string | null;
  readonly model: string | null;
} {
  return {
    harness: metadata.observedHarnessVersion,
    model: metadata.observedModelVersion,
  };
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export class FixtureContestantAdapter implements ContestantAdapter {
  private readonly fixtureRoot: string;
  private readonly delayMs: number;

  public constructor(options: FixtureContestantAdapterOptions) {
    this.fixtureRoot = resolve(options.fixtureRoot);
    this.delayMs = options.delayMs ?? 10;
  }

  public async run(input: ContestantRunInput): Promise<ContestantRunResult> {
    const fixture =
      input.contestant.harness.adapter === "fixture"
        ? input.contestant.harness.fixture
        : "";
    const outcome = fixtureOutcome(fixture);
    const signals: ("SIGTERM" | "SIGKILL")[] = [];
    await mkdir(input.workspacePath, { recursive: true });
    const executionMetadata = await writeFixtureMetadata(input);
    const observedVersions = observedVersionsOf(executionMetadata);

    if (outcome === "timeout") {
      await delay(input.timeoutMs + 1);
      signals.push("SIGTERM", "SIGKILL");
      await writeLog(input.stdoutLogPath, [], input.redactionValues);
      await writeLog(input.stderrLogPath, [], input.redactionValues);
      return {
        status: "timeout",
        exitCode: null,
        timedOut: true,
        attemptCount: 1,
        usage: emptyUsage(false),
        observedVersions,
        executionMetadata,
        metadataProduced: true,
        error: "fixture contestant timed out",
        submissionProduced: false,
        usageProduced: false,
        terminationSignals: signals,
      };
    }

    await delay(this.delayMs);
    if (outcome === "failure") {
      await writeLog(input.stdoutLogPath, [], input.redactionValues);
      await writeLog(
        input.stderrLogPath,
        [Buffer.from("fixture process failed\n")],
        input.redactionValues,
      );
      return {
        status: "failed",
        exitCode: 1,
        timedOut: false,
        attemptCount: 1,
        usage: emptyUsage(false),
        observedVersions,
        executionMetadata,
        metadataProduced: true,
        error: "fixture contestant failed",
        submissionProduced: false,
        usageProduced: false,
        terminationSignals: signals,
      };
    }

    let copyError: string | null = null;
    if (outcome === "success") {
      try {
        const sourcePath = fixturePath(this.fixtureRoot, fixture);
        if (!(await regularFileExists(sourcePath))) {
          throw new Error(`fixture stylesheet does not exist: ${fixture}`);
        }
        await copyFile(sourcePath, input.submissionPath);
      } catch (error) {
        copyError = error instanceof Error ? error.message : String(error);
      }
    }
    const submissionProduced = await regularFileExists(input.submissionPath);
    await writeLog(input.stdoutLogPath, [], input.redactionValues);
    await writeLog(input.stderrLogPath, [], input.redactionValues);
    if (copyError !== null) {
      return resultWithError(
        {
          status: "failed",
          exitCode: 1,
          timedOut: false,
          attemptCount: 1,
          usage: emptyUsage(false),
          observedVersions,
          executionMetadata,
          metadataProduced: true,
          submissionProduced,
          usageProduced: false,
          terminationSignals: signals,
        },
        copyError,
      );
    }
    return {
      status: submissionProduced ? "succeeded" : "missing_submission",
      exitCode: 0,
      timedOut: false,
      attemptCount: 1,
      usage: emptyUsage(false),
      observedVersions,
      executionMetadata,
      metadataProduced: true,
      error: submissionProduced
        ? null
        : "fixture contestant produced no submission.css",
      submissionProduced,
      usageProduced: false,
      terminationSignals: signals,
    };
  }
}
