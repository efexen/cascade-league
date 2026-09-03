import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CommandContestantAdapter,
  type ContestantRunInput,
} from "../../src/contestants/index.js";
import { runContestant } from "../../integrations/codex/contestant.js";
import { readCodexVersion } from "../../integrations/codex/shared.js";
import {
  CommandJudgeAdapter,
  type JudgeAwardsInput,
  type JudgeCandidateInput,
} from "../../src/judging/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tsxLoaderPath = join(repositoryRoot, "node_modules/tsx/dist/loader.mjs");

function wrapperCommand(entrypoint: string): string[] {
  return [
    "/usr/bin/env",
    "node",
    "--import",
    tsxLoaderPath,
    join(repositoryRoot, "integrations/codex", entrypoint),
  ];
}

async function writeStub(root: string, body: string): Promise<string> {
  const path = join(root, "codex-stub.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

async function prepareWorkspace(root: string, name: string): Promise<string> {
  const workspace = join(root, name);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function contestantConfig(commandArgv: readonly string[]) {
  return {
    id: "codex-contestant",
    displayName: "Codex CLI + GPT-5.6",
    harness: {
      name: "codex-cli",
      version: "0.150.1",
      adapter: "command" as const,
      command: {
        argv: [
          ...commandArgv,
          "--execution-metadata-path",
          "{executionMetadataOutputPath}",
        ],
        environmentAllowlist: ["HOME", "PATH"],
      },
    },
    model: {
      provider: "openai",
      name: "gpt-5.6",
      version: "gpt-5.6",
      reasoningEffort: "high" as const,
    },
    budget: { timeoutMs: 10_000, maximumTotalTokens: 30_000 },
    enabled: true,
  };
}

function judgeConfig(commandArgv: readonly string[]) {
  return {
    id: "codex-judge",
    displayName: "Codex CLI Judge",
    harness: {
      name: "codex-cli",
      version: "0.150.1",
      adapter: "command" as const,
      command: {
        argv: [
          ...commandArgv,
          "--execution-metadata-path",
          "{executionMetadataOutputPath}",
        ],
        environmentAllowlist: ["HOME", "PATH"],
      },
    },
    model: {
      provider: "openai",
      name: "gpt-5.6",
      version: "gpt-5.6",
      reasoningEffort: "medium" as const,
    },
    budget: { timeoutMs: 10_000, maximumOutputTokens: 4_000 },
    enabled: true,
  };
}

function flagValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  argv.forEach((value, index) => {
    if (value === flag && argv[index + 1] !== undefined) values.push(argv[index + 1]!);
  });
  return values;
}

function recordPath(workspace: string, suffix: string): string {
  return join(workspace, `.stub-record-${suffix}.json`);
}

function readRecord(
  workspace: string,
  suffix: string,
): Promise<{
  readonly args: string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly apiKey: string | null;
  readonly imagePaths: string[];
  readonly schemaPath: string | null;
  readonly outputPath: string | null;
}> {
  return readFile(recordPath(workspace, suffix), "utf8").then(
    (value) =>
      JSON.parse(value) as {
        args: string[];
        cwd: string;
        stdin: string;
        apiKey: string | null;
        imagePaths: string[];
        schemaPath: string | null;
        outputPath: string | null;
      },
  );
}

const RECORDING_STUB = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 0.150.1\n");
  process.exit(0);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");
const images = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--image" && args[index + 1] !== undefined) images.push(args[index + 1]);
}
const schemaIndex = args.indexOf("--output-schema");
const outputIndex = args.indexOf("--output-last-message");
const schemaPath = schemaIndex === -1 ? null : args[schemaIndex + 1];
const outputPath = outputIndex === -1 ? null : args[outputIndex + 1];
const suffix = schemaPath?.endsWith("awards-output-schema.json") ? "awards" : "score";
writeFileSync(join(process.cwd(), ".stub-record-" + suffix + ".json"), JSON.stringify({
  args,
  cwd: process.cwd(),
  stdin,
  apiKey: process.env.CODEX_API_KEY ?? null,
  imagePaths: images,
  schemaPath,
  outputPath,
}));
if (outputPath !== null) {
  const isAwards = suffix === "awards";
  const output = isAwards
    ? JSON.stringify({ schemaVersion: 1, generationId: "0001", judgeId: "codex-judge", awards: [] })
    : JSON.stringify({
        schemaVersion: 1,
        generationId: "0001",
        judgeId: "codex-judge",
        anonymousCandidateId: "candidate-abcd",
        scores: {
          hierarchyAndReadability: 13,
          composition: 12,
          typography: 12,
          colourAndVisualSystem: 8,
          coherenceAndCraft: 12,
          originalityAndMemorability: 17,
          constraintAndCssCraft: 8,
        },
        totalScore: 82,
        critique: "The hierarchy is clear and the palette is deliberate. Increase the lower-page contrast next.",
        strongestQuality: "Clear hierarchy",
        primaryWeakness: "Quiet lower page",
        nextMove: "Increase lower-page contrast",
        confidence: "medium",
        flags: [],
      });
  writeFileSync(outputPath, output);
}
if (suffix === "score" && !existsSync(join(process.cwd(), "submission.css"))) {
  writeFileSync(join(process.cwd(), "submission.css"), "body { color: red; }\n");
}
`;

const FAILING_STUB = String.raw`
import { appendFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.150.1\n");
  process.exit(0);
}
appendFileSync(join(process.cwd(), "stub-calls.log"), "call\n");
process.stderr.write("transport failure from stub\n");
process.exit(23);
`;

const NO_SUBMISSION_STUB = String.raw`
import { appendFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.150.1\n");
  process.exit(0);
}
appendFileSync(join(process.cwd(), "stub-calls.log"), "call\n");
`;

const STDERR_DIAGNOSTIC_MARKER = "codex-stderr-marker-4f9c1a";

const NOISY_FAILING_STUB = String.raw`
import { appendFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.150.1\n");
  process.exit(0);
}
appendFileSync(join(process.cwd(), "stub-calls.log"), "call\n");
process.stderr.write("x".repeat(4096) + "\n");
process.stderr.write("rejection reason ${STDERR_DIAGNOSTIC_MARKER}\n");
process.exit(23);
`;

describe("Codex CLI integration contracts", () => {
  it("records the actual Codex executable version", async () => {
    const root = await mkdtemp(join(tmpdir(), "cascade-league-codex-version-"));
    const stubPath = await writeStub(root, RECORDING_STUB);

    await expect(readCodexVersion(stubPath)).resolves.toBe("0.150.1");
  });

  it("constructs a one-shot contestant invocation and collects CSS plus bounded metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "cascade-league-codex-contestant-"));
    const workspace = await prepareWorkspace(root, "workspace");
    const stubPath = await writeStub(root, RECORDING_STUB);
    const challengePath = join(workspace, "challenge.html");
    const starterCssPath = join(workspace, "starter.css");
    const promptPath = join(workspace, "prompt.md");
    const submissionPath = join(workspace, "submission.css");
    const metadataPath = join(workspace, "execution-metadata.json");
    await writeFile(challengePath, "<!doctype html><title>Challenge</title>", "utf8");
    await writeFile(starterCssPath, ":root {}\n", "utf8");
    await writeFile(promptPath, "PROMPT FROM LEAGUE\n", "utf8");

    const command = [
      ...wrapperCommand("contestant.ts"),
      "--codex-path",
      stubPath,
      "--codex-version",
      "0.150.1",
      "--model",
      "gpt-5.6",
      "--reasoning-effort",
      "high",
      "--workspace-path",
      "{workspacePath}",
      "--challenge-path",
      "{challengePath}",
      "--starter-css-path",
      "{starterCssPath}",
      "--prompt-path",
      "{promptPath}",
      "--submission-path",
      "{submissionPath}",
    ];
    const input: ContestantRunInput = {
      generationId: "0001",
      contestantId: "codex-contestant",
      anonymousCandidateId: "candidate-abcd",
      contestant: contestantConfig(command),
      workspacePath: workspace,
      challengePath,
      starterCssPath,
      promptPath,
      submissionPath,
      usageOutputPath: join(workspace, "usage.json"),
      executionMetadataOutputPath: metadataPath,
      stdoutLogPath: join(root, "stdout.log"),
      stderrLogPath: join(root, "stderr.log"),
      timeoutMs: 10_000,
      maximumTotalTokens: 30_000,
    };

    const result = await new CommandContestantAdapter({
      environment: {
        HOME: root,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CODEX_API_KEY: "must-not-reach-codex",
      },
    }).run(input);

    expect(result.status).toBe("succeeded");
    expect(result.attemptCount).toBe(1);
    expect(result.submissionProduced).toBe(true);
    expect(result.usageProduced).toBe(false);
    expect(result.usage.totalTokens).toBeNull();
    expect(result.executionMetadata).toEqual({
      observedHarnessVersion: "0.150.1",
      observedModelVersion: "gpt-5.6",
      providerRequestId: null,
    });
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual({
      schemaVersion: 1,
      observedHarnessVersion: "0.150.1",
      observedModelVersion: "gpt-5.6",
      providerRequestId: null,
    });
    expect(await readFile(submissionPath, "utf8")).toBe("body { color: red; }\n");

    const record = await readRecord(workspace, "score");
    expect(record.cwd).toBe(await realpath(workspace));
    expect(record.stdin).toContain("PROMPT FROM LEAGUE");
    expect(record.stdin).toContain(
      `Write exactly one regular file named submission.css at ${submissionPath}.`,
    );
    expect(record.stdin).toContain(
      "Do not use browser, computer-use, screenshot, preview, or visual inspection tools.",
    );
    expect(record.apiKey).toBeNull();
    expect(record.args).toEqual([
      "exec",
      "--model",
      "gpt-5.6",
      "-c",
      "model_reasoning_effort=high",
      "--sandbox",
      "workspace-write",
      "-C",
      workspace,
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "-c",
      "features.browser_use=false",
      "-c",
      "features.browser_use_external=false",
      "-c",
      "features.computer_use=false",
      "--output-last-message",
      expect.any(String),
      "-",
    ]);
    expect(record.args).not.toContain("--image");
    expect(record.args).not.toContain("--output-schema");
    expect(flagValues(record.args, "--output-last-message")[0]).toMatch(
      new RegExp(`^${workspace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`),
    );
  });

  it("propagates a Codex transport failure once and does not retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "cascade-league-codex-failure-"));
    const workspace = await prepareWorkspace(root, "workspace");
    const stubPath = await writeStub(root, FAILING_STUB);
    const challengePath = join(workspace, "challenge.html");
    const starterCssPath = join(workspace, "starter.css");
    const promptPath = join(workspace, "prompt.md");
    const submissionPath = join(workspace, "submission.css");
    await writeFile(challengePath, "<!doctype html>", "utf8");
    await writeFile(starterCssPath, ":root {}\n", "utf8");
    await writeFile(promptPath, "FAILURE PROMPT\n", "utf8");

    const command = [
      ...wrapperCommand("contestant.ts"),
      "--codex-path",
      stubPath,
      "--codex-version",
      "0.150.1",
      "--model",
      "gpt-5.6",
      "--reasoning-effort",
      "high",
      "--workspace-path",
      "{workspacePath}",
      "--challenge-path",
      "{challengePath}",
      "--starter-css-path",
      "{starterCssPath}",
      "--prompt-path",
      "{promptPath}",
      "--submission-path",
      "{submissionPath}",
    ];
    const result = await new CommandContestantAdapter({
      environment: {
        HOME: root,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
    }).run({
      generationId: "0001",
      contestantId: "codex-contestant",
      anonymousCandidateId: "candidate-abcd",
      contestant: contestantConfig(command),
      workspacePath: workspace,
      challengePath,
      starterCssPath,
      promptPath,
      submissionPath,
      usageOutputPath: join(workspace, "usage.json"),
      executionMetadataOutputPath: join(workspace, "execution-metadata.json"),
      stdoutLogPath: join(root, "stdout.log"),
      stderrLogPath: join(root, "stderr.log"),
      timeoutMs: 10_000,
      maximumTotalTokens: 30_000,
    });

    expect(result.status).toBe("failed");
    expect(result.attemptCount).toBe(1);
    expect(result.submissionProduced).toBe(false);
    expect(await readFile(join(root, "stderr.log"), "utf8")).toContain(
      "codex exited with code 23",
    );
    expect(
      (await readFile(join(workspace, "stub-calls.log"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  });

  it("surfaces a bounded Codex stderr diagnostic exactly once on transport failure", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cascade-league-codex-stderr-diagnostic-"),
    );
    const workspace = await prepareWorkspace(root, "workspace");
    const stubPath = await writeStub(root, NOISY_FAILING_STUB);
    const challengePath = join(workspace, "challenge.html");
    const starterCssPath = join(workspace, "starter.css");
    const promptPath = join(workspace, "prompt.md");
    const submissionPath = join(workspace, "submission.css");
    await writeFile(challengePath, "<!doctype html>", "utf8");
    await writeFile(starterCssPath, ":root {}\n", "utf8");
    await writeFile(promptPath, "DIAGNOSTIC PROMPT\n", "utf8");

    const command = [
      ...wrapperCommand("contestant.ts"),
      "--codex-path",
      stubPath,
      "--codex-version",
      "0.150.1",
      "--model",
      "gpt-5.6",
      "--reasoning-effort",
      "high",
      "--workspace-path",
      "{workspacePath}",
      "--challenge-path",
      "{challengePath}",
      "--starter-css-path",
      "{starterCssPath}",
      "--prompt-path",
      "{promptPath}",
      "--submission-path",
      "{submissionPath}",
    ];
    const result = await new CommandContestantAdapter({
      environment: {
        HOME: root,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
    }).run({
      generationId: "0001",
      contestantId: "codex-contestant",
      anonymousCandidateId: "candidate-abcd",
      contestant: contestantConfig(command),
      workspacePath: workspace,
      challengePath,
      starterCssPath,
      promptPath,
      submissionPath,
      usageOutputPath: join(workspace, "usage.json"),
      executionMetadataOutputPath: join(workspace, "execution-metadata.json"),
      stdoutLogPath: join(root, "stdout.log"),
      stderrLogPath: join(root, "stderr.log"),
      timeoutMs: 10_000,
      maximumTotalTokens: 30_000,
    });

    expect(result.status).toBe("failed");
    expect(result.attemptCount).toBe(1);
    const stderrLog = await readFile(join(root, "stderr.log"), "utf8");
    expect(stderrLog).toContain("codex exited with code 23");
    expect(stderrLog).toContain(`rejection reason ${STDERR_DIAGNOSTIC_MARKER}`);
    expect(stderrLog.split(STDERR_DIAGNOSTIC_MARKER).length - 1).toBe(1);
    expect(stderrLog).not.toContain("x".repeat(2048));
    expect(stderrLog.length).toBeLessThan(4096);
    expect(
      (await readFile(join(workspace, "stub-calls.log"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  });

  it("rejects a successful invocation that does not leave a regular submission file", async () => {
    const root = await mkdtemp(join(tmpdir(), "cascade-league-codex-missing-output-"));
    const workspace = await prepareWorkspace(root, "workspace");
    const stubPath = await writeStub(root, NO_SUBMISSION_STUB);
    const challengePath = join(workspace, "challenge.html");
    const starterCssPath = join(workspace, "starter.css");
    const promptPath = join(workspace, "prompt.md");
    const submissionPath = join(workspace, "submission.css");
    await writeFile(challengePath, "<!doctype html>", "utf8");
    await writeFile(starterCssPath, ":root {}\n", "utf8");
    await writeFile(promptPath, "MISSING OUTPUT PROMPT\n", "utf8");

    await expect(
      runContestant({
        codexPath: stubPath,
        codexVersion: "0.150.1",
        model: "gpt-5.6",
        reasoningEffort: "high",
        workspacePath: workspace,
        challengePath,
        starterCssPath,
        promptPath,
        submissionPath,
        executionMetadataPath: join(workspace, "execution-metadata.json"),
      }),
    ).rejects.toThrow("submission.css is missing");
    expect(
      (await readFile(join(workspace, "stub-calls.log"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  });

  it("infers score versus awards from the generic judge path aliases and passes staged inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "cascade-league-codex-judge-"));
    const scoreWorkspace = await prepareWorkspace(root, "score-workspace");
    const awardsWorkspace = await prepareWorkspace(root, "awards-workspace");
    const stubPath = await writeStub(root, RECORDING_STUB);
    const command = [
      ...wrapperCommand("judge.ts"),
      "--codex-path",
      stubPath,
      "--codex-version",
      "0.150.1",
      "--model",
      "gpt-5.6",
      "--reasoning-effort",
      "medium",
      "--workspace-path",
      "{workspacePath}",
      "--prompt-path",
      "{promptPath}",
      "--candidate-screenshot-path",
      "{candidateScreenshotPath}",
      "--contact-sheet-path",
      "{contactSheetPath}",
      "--sanitised-css-path",
      "{sanitisedCssPath}",
      "--judgment-path",
      "{judgmentPath}",
      "--judgment-summary-path",
      "{judgmentSummaryPath}",
      "--awards-path",
      "{awardsPath}",
    ];
    const judge = judgeConfig(command);

    const scoreInput: JudgeCandidateInput = {
      generationId: "0001",
      judgeId: "codex-judge",
      anonymousCandidateId: "candidate-abcd",
      judge,
      workspacePath: scoreWorkspace,
      promptPath: join(scoreWorkspace, "prompt.md"),
      candidateScreenshotPath: join(scoreWorkspace, "candidate.png"),
      contactSheetPath: join(scoreWorkspace, "cohort.png"),
      sanitisedCssPath: join(scoreWorkspace, "candidate.css"),
      judgmentPath: join(scoreWorkspace, "judgment.json"),
      rawOutputPath: join(root, "score-raw.json"),
      usageOutputPath: join(scoreWorkspace, "usage.json"),
      executionMetadataOutputPath: join(scoreWorkspace, "execution-metadata.json"),
      stdoutLogPath: join(root, "score.stdout.log"),
      stderrLogPath: join(root, "score.stderr.log"),
      timeoutMs: 10_000,
      maximumOutputTokens: 4_000,
    };
    await writeFile(scoreInput.promptPath, "SCORE PROMPT\n", "utf8");
    await writeFile(scoreInput.candidateScreenshotPath, "candidate png", "utf8");
    await writeFile(scoreInput.contactSheetPath, "cohort png", "utf8");
    await writeFile(
      scoreInput.sanitisedCssPath,
      ":root { --contract: score; }\n",
      "utf8",
    );

    const scoreResult = await new CommandJudgeAdapter({
      environment: {
        HOME: root,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CODEX_API_KEY: "must-not-reach-codex",
      },
    }).scoreCandidate(scoreInput);

    expect(scoreResult.status).toBe("succeeded");
    expect(scoreResult.judgment?.totalScore).toBe(82);
    expect(scoreResult.executionMetadata).toEqual({
      observedHarnessVersion: "0.150.1",
      observedModelVersion: "gpt-5.6",
      providerRequestId: null,
    });
    const scoreRecord = await readRecord(scoreWorkspace, "score");
    expect(scoreRecord.cwd).toBe(await realpath(scoreWorkspace));
    expect(scoreRecord.apiKey).toBeNull();
    expect(scoreRecord.imagePaths).toEqual([
      scoreInput.candidateScreenshotPath,
      scoreInput.contactSheetPath,
    ]);
    expect(scoreRecord.stdin).toContain("SCORE PROMPT");
    expect(scoreRecord.stdin).toContain(":root { --contract: score; }");
    expect(scoreRecord.stdin).not.toContain(scoreInput.sanitisedCssPath);
    expect(scoreRecord.schemaPath).toMatch(/score-output-schema\.json$/u);
    const scoreSchema = JSON.parse(await readFile(scoreRecord.schemaPath!, "utf8")) as {
      additionalProperties: boolean;
      required: string[];
    };
    expect(scoreSchema.additionalProperties).toBe(false);
    expect(scoreSchema.required).toContain("scores");
    expect(scoreSchema.required).toContain("totalScore");
    expect(JSON.parse(await readFile(scoreInput.judgmentPath, "utf8"))).toMatchObject({
      totalScore: 82,
    });
    expect(flagValues(scoreRecord.args, "--sandbox")).toEqual(["read-only"]);
    expect(scoreRecord.args.at(-1)).toBe("-");

    const summary = JSON.stringify({
      schemaVersion: 1,
      generationId: "0001",
      judgeId: "codex-judge",
      entries: [
        {
          anonymousCandidateId: "candidate-abcd",
          totalScore: 82,
          originalityScore: 17,
          critique: "The hierarchy is clear.",
        },
      ],
    });
    const awardsInput: JudgeAwardsInput = {
      generationId: "0001",
      judgeId: "codex-judge",
      judge,
      workspacePath: awardsWorkspace,
      promptPath: join(awardsWorkspace, "prompt.md"),
      contactSheetPath: join(awardsWorkspace, "cohort.png"),
      judgmentSummaryPath: join(awardsWorkspace, "judgment-summary.json"),
      awardsPath: join(awardsWorkspace, "awards.json"),
      usageOutputPath: join(awardsWorkspace, "usage.json"),
      executionMetadataOutputPath: join(awardsWorkspace, "execution-metadata.json"),
      rawOutputPath: join(root, "awards-raw.json"),
      stdoutLogPath: join(root, "awards.stdout.log"),
      stderrLogPath: join(root, "awards.stderr.log"),
      timeoutMs: 10_000,
      maximumOutputTokens: 4_000,
      candidates: [
        {
          anonymousCandidateId: "candidate-abcd",
          judgment: scoreResult.judgment,
          sanitisedCssPath: join(awardsWorkspace, "candidate.css"),
        },
      ],
    };
    await writeFile(awardsInput.promptPath, "AWARDS PROMPT\n", "utf8");
    await writeFile(awardsInput.contactSheetPath, "cohort png", "utf8");
    await writeFile(awardsInput.judgmentSummaryPath, summary, "utf8");

    const awardsResult = await new CommandJudgeAdapter({
      environment: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    }).createAwards(awardsInput);

    expect(awardsResult.status).toBe("succeeded");
    expect(awardsResult.awards?.awards).toEqual([]);
    const awardsRecord = await readRecord(awardsWorkspace, "awards");
    expect(awardsRecord.imagePaths).toEqual([awardsInput.contactSheetPath]);
    expect(awardsRecord.stdin).toContain("AWARDS PROMPT");
    expect(awardsRecord.stdin).toContain(summary);
    expect(awardsRecord.schemaPath).toMatch(/awards-output-schema\.json$/u);
    const awardsSchema = JSON.parse(
      await readFile(awardsRecord.schemaPath!, "utf8"),
    ) as { additionalProperties: boolean; required: string[] };
    expect(awardsSchema.additionalProperties).toBe(false);
    expect(awardsSchema.required).toEqual([
      "schemaVersion",
      "generationId",
      "judgeId",
      "awards",
    ]);
    expect(JSON.parse(await readFile(awardsInput.awardsPath, "utf8"))).toEqual({
      schemaVersion: 1,
      generationId: "0001",
      judgeId: "codex-judge",
      awards: [],
    });
    expect(flagValues(awardsRecord.args, "--sandbox")).toEqual(["read-only"]);
    expect(awardsRecord.args.at(-1)).toBe("-");
  });
});
