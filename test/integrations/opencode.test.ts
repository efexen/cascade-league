import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CommandContestantAdapter,
  type ContestantRunInput,
} from "../../src/contestants/index.js";
import {
  CommandJudgeAdapter,
  type JudgeAwardsInput,
  type JudgeCandidateInput,
} from "../../src/judging/index.js";
import { extractLastJsonValue } from "../../integrations/opencode/shared.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tsxLoaderPath = join(repositoryRoot, "node_modules/tsx/dist/loader.mjs");

const OFFLINE_OPENCODE_STUB = String.raw`
if (process.argv.includes("--version")) {
  const fs = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  await fs.writeFile(join(dirname(fileURLToPath(import.meta.url)), "version-env.json"), JSON.stringify({ openRouterKeyPresent: Boolean(process.env.OPENROUTER_API_KEY) }));
  process.stdout.write("1.18.25\n");
  process.exit(0);
}
const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const message = dirIndex === -1 ? "" : (args[dirIndex + 2] ?? "");
const fs = await import("node:fs/promises");
await fs.writeFile("opencode-argv.json", JSON.stringify({ args, home: process.env.HOME, path: process.env.PATH, openRouterKeyPresent: Boolean(process.env.OPENROUTER_API_KEY) }));
await fs.appendFile("opencode-invocations.log", "invoked\n");
if (message.includes("AWARDS")) {
  const awards = { schemaVersion: 1, generationId: "0001", judgeId: "opencode-judge", awards: [] };
  process.stdout.write(JSON.stringify({ type: "text", part: { text: "prefix\\n" + JSON.stringify(awards) } }) + "\n");
} else if (message.includes("SCORE")) {
  const score = { schemaVersion: 1, generationId: "0001", judgeId: "opencode-judge", anonymousCandidateId: "candidate-abcd", scores: { hierarchyAndReadability: 13, composition: 12, typography: 12, colourAndVisualSystem: 8, coherenceAndCraft: 12, originalityAndMemorability: 17, constraintAndCssCraft: 8 }, totalScore: 82, critique: "Clear hierarchy. Increase contrast next.", strongestQuality: "Hierarchy", primaryWeakness: "Contrast", nextMove: "Increase contrast", confidence: "medium", flags: [] };
  process.stdout.write(JSON.stringify({ type: "text", part: { text: JSON.stringify(score) } }) + "\n");
} else {
  await fs.writeFile("submission.css", "body { color: red; }\n");
}
`;

async function writeStub(root: string): Promise<string> {
  const path = join(root, "opencode-stub.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${OFFLINE_OPENCODE_STUB}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

function wrapperCommand(entrypoint: string): string[] {
  return [
    "/usr/bin/env",
    "node",
    "--import",
    tsxLoaderPath,
    join(repositoryRoot, "integrations/opencode", entrypoint),
  ];
}

function contestantConfig(
  argv: readonly string[],
  environmentAllowlist: readonly string[] = ["HOME", "PATH"],
) {
  return {
    id: "opencode-contestant",
    displayName: "OpenCode Contestant",
    harness: {
      name: "opencode-cli",
      version: "1.18.25",
      adapter: "command" as const,
      command: { argv: [...argv], environmentAllowlist: [...environmentAllowlist] },
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

function judgeConfig(argv: readonly string[]) {
  return {
    id: "opencode-judge",
    displayName: "OpenCode Judge",
    harness: {
      name: "opencode-cli",
      version: "1.18.25",
      adapter: "command" as const,
      command: { argv: [...argv], environmentAllowlist: ["HOME", "PATH"] },
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

describe("OpenCode CLI integration contracts", () => {
  it("extracts the complete judgment when a text event prefixes nested JSON", () => {
    const judgment = {
      schemaVersion: 1,
      scores: { composition: 12 },
      flags: [],
    };
    const output = `${JSON.stringify({
      type: "text",
      part: { text: `Here is the result:\n${JSON.stringify(judgment)}` },
    })}\n`;

    expect(JSON.parse(extractLastJsonValue(output))).toEqual(judgment);
  });

  it("forwards OpenRouter credentials only to OpenRouter model runs, never to version probes", async () => {
    const root = await createTestTempRoot("cascade-league-opencode-openrouter-");
    const executable = await writeStub(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const challengePath = join(workspace, "challenge.html");
    const starterCssPath = join(workspace, "starter.css");
    const promptPath = join(workspace, "prompt.md");
    await writeFile(challengePath, "<main>challenge</main>\n", "utf8");
    await writeFile(starterCssPath, ":root {}\n", "utf8");
    await writeFile(promptPath, "CONTESTANT PROMPT\n", "utf8");

    const invoke = async (model: string, suffix: string) => {
      const runWorkspace = join(root, suffix);
      await mkdir(runWorkspace, { recursive: true });
      const outputPath = join(runWorkspace, "submission.css");
      const argv = [
        ...wrapperCommand("contestant.ts"),
        "--opencode-path",
        executable,
        "--opencode-version",
        "1.18.25",
        "--model",
        model,
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
        "--execution-metadata-path",
        "{executionMetadataOutputPath}",
      ];
      const input: ContestantRunInput = {
        generationId: "0001",
        contestantId: "opencode-contestant",
        anonymousCandidateId: "candidate-abcd",
        contestant: contestantConfig(argv, ["HOME", "PATH", "OPENROUTER_API_KEY"]),
        workspacePath: runWorkspace,
        challengePath,
        starterCssPath,
        promptPath,
        submissionPath: outputPath,
        usageOutputPath: join(runWorkspace, "usage.json"),
        executionMetadataOutputPath: join(runWorkspace, "execution-metadata.json"),
        stdoutLogPath: join(runWorkspace, "stdout.log"),
        stderrLogPath: join(runWorkspace, "stderr.log"),
        timeoutMs: 10_000,
        maximumTotalTokens: 30_000,
      };
      const result = await new CommandContestantAdapter({
        environment: {
          HOME: root,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          OPENROUTER_API_KEY: "synthetic-test-key-do-not-log",
        },
      }).run(input);
      expect(result.status).toBe("succeeded");
      expect(await readFile(outputPath, "utf8")).toBe("body { color: red; }\n");
      const record = JSON.parse(
        await readFile(join(runWorkspace, "opencode-argv.json"), "utf8"),
      ) as { args: string[]; openRouterKeyPresent: boolean };
      expect(record.args.slice(0, 5)).toEqual([
        "run",
        "--format",
        "json",
        "--model",
        model,
      ]);
      expect(record.openRouterKeyPresent).toBe(model.startsWith("openrouter/"));
      expect(
        (await readFile(join(runWorkspace, "opencode-invocations.log"), "utf8"))
          .trim()
          .split("\n"),
      ).toHaveLength(1);
      expect(
        JSON.parse(await readFile(join(root, "version-env.json"), "utf8")),
      ).toEqual({
        openRouterKeyPresent: false,
      });
    };

    await invoke("openrouter/qwen/qwen3-coder-next", "openrouter-run");
    await invoke("opencode-go/mimo-v2.6-flash", "go-run");
  });

  it("uses one-shot JSONL run protocol for contestant and anonymous judge operations", async () => {
    const root = await createTestTempRoot("cascade-league-opencode-");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const executable = await writeStub(root);
    const challengePath = join(workspace, "challenge.html");
    const starterCssPath = join(workspace, "starter.css");
    const promptPath = join(workspace, "prompt.md");
    const submissionPath = join(workspace, "submission.css");
    await writeFile(challengePath, "<main>challenge</main>\n", "utf8");
    await writeFile(starterCssPath, ":root {}\n", "utf8");
    await writeFile(promptPath, "CONTESTANT PROMPT\n", "utf8");

    const contestantArgv = [
      ...wrapperCommand("contestant.ts"),
      "--opencode-path",
      executable,
      "--opencode-version",
      "1.18.25",
      "--model",
      "openai/gpt-5.6",
      "--variant",
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
    const contestantInput: ContestantRunInput = {
      generationId: "0001",
      contestantId: "opencode-contestant",
      anonymousCandidateId: "candidate-abcd",
      contestant: contestantConfig([
        ...contestantArgv,
        "--execution-metadata-path",
        "{executionMetadataOutputPath}",
      ]),
      workspacePath: workspace,
      challengePath,
      starterCssPath,
      promptPath,
      submissionPath,
      usageOutputPath: join(workspace, "usage.json"),
      executionMetadataOutputPath: join(workspace, "execution-metadata.json"),
      stdoutLogPath: join(root, "contestant.stdout.log"),
      stderrLogPath: join(root, "contestant.stderr.log"),
      timeoutMs: 10_000,
      maximumTotalTokens: 30_000,
    };
    const contestantResult = await new CommandContestantAdapter({
      environment: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    }).run(contestantInput);
    expect(contestantResult.status).toBe("succeeded");
    expect(await readFile(submissionPath, "utf8")).toBe("body { color: red; }\n");
    expect(contestantResult.executionMetadata).toEqual({
      observedHarnessVersion: "1.18.25",
      observedModelVersion: "openai/gpt-5.6",
      providerRequestId: null,
    });
    const contestantRecord = JSON.parse(
      await readFile(join(workspace, "opencode-argv.json"), "utf8"),
    ) as { args: string[]; home: string; path: string };
    expect(contestantRecord.args).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "openai/gpt-5.6",
      "--variant",
      "high",
      "--dir",
      workspace,
      expect.stringContaining("submission.css"),
      "--file",
      challengePath,
      "--file",
      starterCssPath,
    ]);
    expect(contestantRecord.home).toBe(root);

    const candidateScreenshotPath = join(workspace, "candidate.png");
    const contactSheetPath = join(workspace, "cohort.png");
    const sanitisedCssPath = join(workspace, "candidate.css");
    await writeFile(candidateScreenshotPath, "png", "utf8");
    await writeFile(contactSheetPath, "cohort", "utf8");
    await writeFile(sanitisedCssPath, "body {}\n", "utf8");
    const judgeArgv = [
      ...wrapperCommand("judge.ts"),
      "--opencode-path",
      executable,
      "--opencode-version",
      "1.18.25",
      "--model",
      "openai/gpt-5.6",
      "--variant",
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
      "--execution-metadata-path",
      "{executionMetadataOutputPath}",
    ];
    const judgeInput: JudgeCandidateInput = {
      generationId: "0001",
      judgeId: "opencode-judge",
      anonymousCandidateId: "candidate-abcd",
      judge: judgeConfig(judgeArgv),
      workspacePath: workspace,
      promptPath,
      candidateScreenshotPath,
      contactSheetPath,
      sanitisedCssPath,
      judgmentPath: join(workspace, "judgment.json"),
      rawOutputPath: join(root, "raw.json"),
      usageOutputPath: join(workspace, "judge-usage.json"),
      executionMetadataOutputPath: join(workspace, "judge-metadata.json"),
      stdoutLogPath: join(root, "judge.stdout.log"),
      stderrLogPath: join(root, "judge.stderr.log"),
      timeoutMs: 10_000,
      maximumOutputTokens: 4_000,
    };
    await writeFile(promptPath, "SCORE\n", "utf8");
    const judgeResult = await new CommandJudgeAdapter({
      environment: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    }).scoreCandidate(judgeInput);
    expect(judgeResult.status).toBe("succeeded");
    expect(judgeResult.judgment?.totalScore).toBe(82);
    expect(JSON.parse(await readFile(judgeInput.judgmentPath, "utf8"))).toMatchObject({
      totalScore: 82,
    });
    const scoreRecord = JSON.parse(
      await readFile(join(workspace, "opencode-argv.json"), "utf8"),
    ) as { args: string[] };
    const scorePromptIndex = scoreRecord.args.findIndex((argument) =>
      argument.includes("Candidate CSS"),
    );
    expect(scorePromptIndex).toBeGreaterThan(scoreRecord.args.indexOf("--dir"));
    expect(scorePromptIndex).toBeLessThan(scoreRecord.args.indexOf("--file"));
    expect(
      scoreRecord.args.filter((argument) =>
        [candidateScreenshotPath, contactSheetPath].includes(argument),
      ),
    ).toEqual([candidateScreenshotPath, contactSheetPath]);

    const judgmentSummaryPath = join(workspace, "judgment-summary.json");
    const awardsPath = join(workspace, "awards.json");
    await writeFile(judgmentSummaryPath, "AWARDS\n", "utf8");
    const awardsInput: JudgeAwardsInput = {
      generationId: "0001",
      judgeId: "opencode-judge",
      judge: judgeConfig(judgeArgv),
      workspacePath: workspace,
      promptPath,
      contactSheetPath,
      judgmentSummaryPath,
      awardsPath,
      usageOutputPath: join(workspace, "awards-usage.json"),
      executionMetadataOutputPath: join(workspace, "awards-metadata.json"),
      rawOutputPath: join(root, "awards-raw.json"),
      stdoutLogPath: join(root, "awards.stdout.log"),
      stderrLogPath: join(root, "awards.stderr.log"),
      timeoutMs: 10_000,
      maximumOutputTokens: 4_000,
      candidates: [],
    };
    const awardsResult = await new CommandJudgeAdapter({
      environment: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    }).createAwards(awardsInput);
    expect(awardsResult.status).toBe("succeeded");
    expect(awardsResult.awards?.awards).toEqual([]);
    expect(JSON.parse(await readFile(awardsPath, "utf8"))).toEqual({
      schemaVersion: 1,
      generationId: "0001",
      judgeId: "opencode-judge",
      awards: [],
    });
  });
});
