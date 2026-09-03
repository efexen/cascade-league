import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FixtureJudgeAdapter,
  CommandJudgeAdapter,
  type JudgeCandidateInput,
  type JudgeAwardsInput,
} from "../../src/judging/index.js";
import { ExecutionMetadataFileSchema } from "../../src/contestants/support.js";
import {
  CandidateJudgmentSchema,
  JudgeCandidateResponseSchema,
} from "../../src/schemas/index.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

function candidateInput(root: string): JudgeCandidateInput {
  return {
    generationId: "0001",
    judgeId: "fixture-critic-a",
    anonymousCandidateId: "candidate-abcd",
    judge: {
      id: "fixture-critic-a",
      displayName: "Fixture Critic A",
      harness: {
        name: "fixture-judge",
        version: "1.0.0",
        adapter: "fixture",
        fixture: "critic-a",
      },
      model: {
        provider: "local-fixture",
        name: "critic-a-model",
        version: "1.0.0",
      },
      enabled: true,
    },
    workspacePath: root,
    promptPath: join(root, "prompt.md"),
    candidateScreenshotPath: join(root, "candidate.png"),
    contactSheetPath: join(root, "cohort.png"),
    sanitisedCssPath: join(root, "candidate.css"),
    judgmentPath: join(root, "judgment.json"),
    rawOutputPath: join(root, "raw.json"),
    usageOutputPath: join(root, "usage.json"),
    executionMetadataOutputPath: join(root, "execution-metadata.json"),
    stdoutLogPath: join(root, "stdout.log"),
    stderrLogPath: join(root, "stderr.log"),
    timeoutMs: 1000,
    maximumOutputTokens: 100,
  };
}

const CANDIDATE_RESPONSE = {
  schemaVersion: 1,
  generationId: "0001",
  judgeId: "fixture-critic-a",
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
  critique:
    "The hierarchy is clear and the palette feels deliberate. Increase the lower-page contrast next.",
  strongestQuality: "Clear hierarchy",
  primaryWeakness: "Quiet lower page",
  nextMove: "Increase lower-page contrast",
  confidence: "medium",
  flags: [],
};

describe("fixture judge adapter", () => {
  it("emits a strict score response without model usage and a durable judgment with usage", async () => {
    const root = await createTestTempRoot("local-maxima-judge-");
    const input = candidateInput(root);
    await writeFile(
      input.sanitisedCssPath,
      ":root { --fixture-style: editorial; }",
      "utf8",
    );

    const result = await new FixtureJudgeAdapter().scoreCandidate(input);

    expect(result.status).toBe("succeeded");
    expect(result.response).not.toHaveProperty("modelUsage");
    expect(JudgeCandidateResponseSchema.parse(result.response)).toEqual(
      result.response,
    );
    expect(result.judgment).not.toBeNull();
    expect(CandidateJudgmentSchema.parse(result.judgment)).toEqual(result.judgment);
    expect(result.judgment?.modelUsage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
    });
    expect(
      result.judgment?.critique.split(/[.!?]+/u).filter((part) => part.trim()),
    ).toHaveLength(2);
  });

  it("returns bounded emergent awards for a valid anonymous candidate set", async () => {
    const root = await createTestTempRoot("local-maxima-awards-");
    const input = candidateInput(root);
    await writeFile(
      input.sanitisedCssPath,
      ":root { --fixture-style: geometric; }",
      "utf8",
    );
    const candidateResult = await new FixtureJudgeAdapter().scoreCandidate(input);
    const candidateJudgment = candidateResult.judgment;
    const awardsInput: JudgeAwardsInput = {
      generationId: "0001",
      judgeId: input.judgeId,
      judge: input.judge,
      workspacePath: root,
      promptPath: join(root, "awards-prompt.md"),
      contactSheetPath: input.contactSheetPath,
      judgmentSummaryPath: join(root, "summary.json"),
      awardsPath: join(root, "awards.json"),
      usageOutputPath: join(root, "awards-usage.json"),
      executionMetadataOutputPath: join(root, "awards-execution-metadata.json"),
      rawOutputPath: join(root, "awards-raw.json"),
      stdoutLogPath: join(root, "awards.stdout.log"),
      stderrLogPath: join(root, "awards.stderr.log"),
      timeoutMs: 1000,
      maximumOutputTokens: 100,
      candidates: [
        {
          anonymousCandidateId: input.anonymousCandidateId,
          judgment: candidateJudgment,
          sanitisedCssPath: input.sanitisedCssPath,
        },
        {
          anonymousCandidateId: "candidate-efgh",
          judgment: candidateJudgment,
          sanitisedCssPath: input.sanitisedCssPath,
        },
      ],
    };

    const result = await new FixtureJudgeAdapter().createAwards(awardsInput);

    expect(result.status).toBe("succeeded");
    expect(result.awards?.awards.length).toBeGreaterThanOrEqual(0);
    expect(result.awards?.awards.length).toBeLessThanOrEqual(3);
    expect(
      result.awards?.awards.every((award) =>
        [input.anonymousCandidateId, "candidate-efgh"].includes(
          award.anonymousCandidateId,
        ),
      ),
    ).toBe(true);
  });

  it("validates command JSON without model usage and enriches the durable result", async () => {
    const root = await createTestTempRoot("local-maxima-command-judge-");
    const input = candidateInput(root);
    const response = {
      schemaVersion: 1,
      generationId: input.generationId,
      judgeId: input.judgeId,
      anonymousCandidateId: input.anonymousCandidateId,
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
      critique:
        "The hierarchy is clear and the palette feels deliberate. Increase the lower-page contrast next.",
      strongestQuality: "Clear hierarchy",
      primaryWeakness: "Quiet lower page",
      nextMove: "Increase lower-page contrast",
      confidence: "medium",
      flags: [],
    };
    const scriptPath = join(root, "judge.mjs");
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[2], process.env.RESPONSE);",
        "writeFileSync(process.argv[3], JSON.stringify({ inputTokens: 11, outputTokens: 7, totalTokens: 18, estimatedCostUsd: 0.02 }));",
      ].join("\n"),
      "utf8",
    );
    const judge = {
      ...input.judge,
      harness: {
        name: "command-judge",
        adapter: "command" as const,
        command: {
          argv: [process.execPath, scriptPath, "{judgmentPath}", "{usageOutputPath}"],
          environmentAllowlist: ["RESPONSE"],
        },
      },
    };

    const result = await new CommandJudgeAdapter({
      environment: { RESPONSE: JSON.stringify(response) },
    }).scoreCandidate({ ...input, judge });

    expect(result.status).toBe("succeeded");
    expect(result.response).not.toHaveProperty("modelUsage");
    expect(result.judgment?.modelUsage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      estimatedCostUsd: 0.02,
    });
    expect(await readFile(input.rawOutputPath, "utf8")).toContain('"totalScore":82');
  });
});

describe("command judge adapter", () => {
  it("uses complete argv placeholders, shell:false, an environment allowlist, and bounded redacted logs", async () => {
    const root = await createTestTempRoot("local-maxima-command-judge-boundary-");
    const input = candidateInput(root);
    const response = {
      schemaVersion: 1,
      generationId: input.generationId,
      judgeId: input.judgeId,
      anonymousCandidateId: input.anonymousCandidateId,
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
      critique:
        "The hierarchy is clear and the palette feels deliberate. Increase the lower-page contrast next.",
      strongestQuality: "Clear hierarchy",
      primaryWeakness: "Quiet lower page",
      nextMove: "Increase lower-page contrast",
      confidence: "medium",
      flags: [],
    };
    const scriptPath = join(root, "boundary-judge.mjs");
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        'console.log("secret-token=" + process.env.SECRET_TOKEN);',
        'console.error("secret-token=" + process.env.SECRET_TOKEN);',
        "writeFileSync(process.argv[2], process.env.RESPONSE);",
        "writeFileSync(process.argv[3], JSON.stringify({ visible: process.env.SECRET_TOKEN ?? null, hidden: process.env.HIDDEN_SECRET ?? null, argv: process.argv.slice(2) }));",
      ].join("\n"),
      "utf8",
    );
    const judge = {
      ...input.judge,
      harness: {
        name: "command-judge",
        adapter: "command" as const,
        command: {
          argv: [
            process.execPath,
            scriptPath,
            "{judgmentPath}",
            "{usageOutputPath}",
            "{candidateScreenshotPath}",
            "{contactSheetPath}",
            "{sanitisedCssPath}",
            "{promptPath}",
          ],
          environmentAllowlist: ["RESPONSE", "SECRET_TOKEN"],
        },
      },
    };
    let seenShell: boolean | undefined;
    let seenCwd: string | undefined;
    const result = await new CommandJudgeAdapter({
      environment: {
        RESPONSE: JSON.stringify(response),
        SECRET_TOKEN: "secret-token",
        HIDDEN_SECRET: "hidden-secret",
      },
      maximumLogBytes: 64,
      spawnProcess: (executable, arguments_, options) => {
        seenShell = options.shell;
        seenCwd = options.cwd;
        return spawn(executable, arguments_, options);
      },
    }).scoreCandidate({ ...input, judge });

    expect(result.status).toBe("succeeded");
    expect(seenShell).toBe(false);
    expect(seenCwd).toBe(root);
    const observed = JSON.parse(await readFile(input.usageOutputPath, "utf8")) as {
      visible: string | null;
      hidden: string | null;
      argv: string[];
    };
    expect(observed.visible).toBe("secret-token");
    expect(observed.hidden).toBeNull();
    expect(observed.argv).toEqual([
      input.judgmentPath,
      input.usageOutputPath,
      input.candidateScreenshotPath,
      input.contactSheetPath,
      input.sanitisedCssPath,
      input.promptPath,
    ]);
    expect(await readFile(input.stdoutLogPath, "utf8")).not.toContain("secret-token");
    expect(await readFile(input.stderrLogPath, "utf8")).not.toContain("secret-token");
  });

  it("materializes every accepted judge placeholder for both score and awards operations", async () => {
    const root = await createTestTempRoot("local-maxima-command-judge-placeholders-");
    const input = candidateInput(root);
    const response = {
      schemaVersion: 1,
      generationId: input.generationId,
      judgeId: input.judgeId,
      anonymousCandidateId: input.anonymousCandidateId,
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
      critique:
        "The hierarchy is clear and the palette feels deliberate. Increase the lower-page contrast next.",
      strongestQuality: "Clear hierarchy",
      primaryWeakness: "Quiet lower page",
      nextMove: "Increase lower-page contrast",
      confidence: "medium",
      flags: [],
    };
    const awards = {
      schemaVersion: 1,
      generationId: input.generationId,
      judgeId: input.judgeId,
      awards: [],
    };
    const scriptPath = join(root, "all-placeholders.mjs");
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[7], process.env.OUTPUT);",
        "writeFileSync(process.argv[8], JSON.stringify({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }));",
        `writeFileSync(process.argv[11], ${JSON.stringify(
          JSON.stringify({
            schemaVersion: 1,
            observedHarnessVersion: "observed-judge-harness-9.9.9",
            observedModelVersion: "observed-judge-model-8.8.8",
            providerRequestId: "req-judge-private-77",
          }),
        )});`,
      ].join("\n"),
      "utf8",
    );
    const command = {
      name: "all-placeholders",
      adapter: "command" as const,
      command: {
        argv: [
          process.execPath,
          scriptPath,
          "{workspacePath}",
          "{promptPath}",
          "{candidateScreenshotPath}",
          "{contactSheetPath}",
          "{sanitisedCssPath}",
          "{judgmentPath}",
          "{usageOutputPath}",
          "{judgmentSummaryPath}",
          "{awardsPath}",
          "{executionMetadataOutputPath}",
        ],
        environmentAllowlist: ["OUTPUT"],
      },
    };
    const judge = { ...input.judge, harness: command };
    const seen: string[][] = [];
    const spawnProcess = (
      executable: string,
      arguments_: readonly string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      seen.push([...arguments_]);
      return spawn(executable, arguments_, options);
    };
    const candidateResult = await new CommandJudgeAdapter({
      environment: { OUTPUT: JSON.stringify(response) },
      spawnProcess,
    }).scoreCandidate({ ...input, judge });
    const awardsInput: JudgeAwardsInput = {
      generationId: input.generationId,
      judgeId: input.judgeId,
      judge,
      workspacePath: root,
      promptPath: join(root, "awards-prompt.md"),
      contactSheetPath: input.contactSheetPath,
      judgmentSummaryPath: join(root, "summary.json"),
      awardsPath: join(root, "awards.json"),
      usageOutputPath: join(root, "awards-usage.json"),
      executionMetadataOutputPath: join(root, "awards-execution-metadata.json"),
      rawOutputPath: join(root, "awards-raw.json"),
      stdoutLogPath: join(root, "awards.stdout.log"),
      stderrLogPath: join(root, "awards.stderr.log"),
      timeoutMs: 1000,
      maximumOutputTokens: 100,
      candidates: [
        {
          anonymousCandidateId: input.anonymousCandidateId,
          judgment: candidateResult.judgment,
          sanitisedCssPath: input.sanitisedCssPath,
        },
      ],
    };
    const awardsResult = await new CommandJudgeAdapter({
      environment: { OUTPUT: JSON.stringify(awards) },
      spawnProcess,
    }).createAwards(awardsInput);

    expect(candidateResult.status).toBe("succeeded");
    expect(awardsResult.status).toBe("succeeded");
    expect(seen).toHaveLength(2);
    for (const argv of seen) {
      expect(argv.slice(1)).toHaveLength(10);
      expect(argv.slice(1).every((value) => value.length > 0)).toBe(true);
      expect(argv.join(" ")).not.toContain("fixture-editorial");
    }
    // The metadata placeholder materializes to the exact complete path for
    // both operations, and the adapter reads the wrapper's report back.
    expect(seen[0]![10]).toBe(input.executionMetadataOutputPath);
    expect(seen[1]![10]).toBe(awardsInput.executionMetadataOutputPath);
    for (const result of [candidateResult, awardsResult]) {
      expect(result.metadataProduced).toBe(true);
      expect(result.executionMetadata).toEqual({
        observedHarnessVersion: "observed-judge-harness-9.9.9",
        observedModelVersion: "observed-judge-model-8.8.8",
        providerRequestId: "req-judge-private-77",
      });
    }
  });

  it("forces a hung judge from TERM to KILL without retrying", async () => {
    const root = await createTestTempRoot("local-maxima-command-judge-timeout-");
    const input = candidateInput(root);
    const scriptPath = join(root, "hung-judge.mjs");
    await writeFile(
      scriptPath,
      'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 10);',
      "utf8",
    );
    const judge = {
      ...input.judge,
      harness: {
        name: "command-judge",
        adapter: "command" as const,
        command: {
          argv: [process.execPath, scriptPath],
          environmentAllowlist: [],
        },
      },
    };
    const signals: string[] = [];
    const result = await new CommandJudgeAdapter({
      terminationGraceMs: 30,
      spawnProcess: (executable, arguments_, options) => {
        const child = spawn(executable, arguments_, options);
        const kill = child.kill.bind(child);
        child.kill = ((signal?: NodeJS.Signals | number) => {
          signals.push(String(signal));
          return kill(signal);
        }) as typeof child.kill;
        return child;
      },
    }).scoreCandidate({ ...input, judge, timeoutMs: 100 });

    expect(result.status).toBe("timeout");
    expect(result.attemptCount).toBe(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("kills a real judge process group, including a grandchild holding stdio, before the hard deadline", async () => {
    const root = await createTestTempRoot("local-maxima-judge-process-tree-");
    const pidPath = join(root, "pids.txt");
    const scriptPath = join(root, "tree-judge.sh");
    const grandchildCode =
      'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 10);';
    // A POSIX shell group leader records both pids within milliseconds of
    // exec: the grandchild pid is already known at fork time, so the record
    // cannot race the adapter's fixed timeout against slow Node startup.
    // The leader still ignores SIGTERM and the Node grandchild still holds
    // the inherited stdio, so the process-group kill semantics are unchanged.
    await writeFile(
      scriptPath,
      [
        "trap '' TERM",
        `"$2" -e ${JSON.stringify(grandchildCode)} &`,
        'printf \'%s\\n%s\\n\' "$$" "$!" > "$1"',
        "while :; do sleep 60; done",
      ].join("\n"),
      "utf8",
    );
    const input = candidateInput(root);
    const judge = {
      ...input.judge,
      harness: {
        name: "command-judge",
        adapter: "command" as const,
        command: {
          argv: ["/bin/sh", scriptPath, pidPath, process.execPath],
          environmentAllowlist: [],
        },
      },
    };

    const startedAt = Date.now();
    const result = await Promise.race([
      new CommandJudgeAdapter({ terminationGraceMs: 30 }).scoreCandidate({
        ...input,
        judge,
        timeoutMs: 100,
      }),
      new Promise<null>((resolvePromise) =>
        setTimeout(() => resolvePromise(null), 1500),
      ),
    ]);
    const elapsedMs = Date.now() - startedAt;
    let pids: number[] = [];
    try {
      pids = (await readFile(pidPath, "utf8"))
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10));
    } catch {
      // The assertion below reports a missing process-tree record.
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The adapter may already have killed the process group.
      }
    }

    expect(result).not.toBeNull();
    expect(elapsedMs).toBeLessThan(1500);
    expect(result?.status).toBe("timeout");
    expect(pids).toHaveLength(2);
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 5000);

  it("archives invalid command JSON without repair or retry", async () => {
    const root = await createTestTempRoot("local-maxima-command-judge-invalid-");
    const input = candidateInput(root);
    const scriptPath = join(root, "invalid-judge.mjs");
    const invalidJson = '{"totalScore":"invented"}';
    await writeFile(
      scriptPath,
      `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], ${JSON.stringify(invalidJson)});`,
      "utf8",
    );
    const judge = {
      ...input.judge,
      harness: {
        name: "command-judge",
        adapter: "command" as const,
        command: {
          argv: [process.execPath, scriptPath, "{judgmentPath}"],
          environmentAllowlist: [],
        },
      },
    };

    const result = await new CommandJudgeAdapter().scoreCandidate({ ...input, judge });

    expect(result.status).toBe("invalid");
    expect(result.response).toBeNull();
    expect(result.attemptCount).toBe(1);
    expect(result.rawOutput).toBe('{"totalScore":"invented"}');
    expect(await readFile(input.rawOutputPath, "utf8")).toBe(result.rawOutput);
  });

  it("rejects an oversized sparse judgment before reading or archiving it", async () => {
    const root = await createTestTempRoot("local-maxima-command-judge-sparse-");
    const input = candidateInput(root);
    const scriptPath = join(root, "sparse-judge.mjs");
    await writeFile(
      scriptPath,
      'import { truncateSync, writeFileSync } from "node:fs"; writeFileSync(process.argv[2], ""); truncateSync(process.argv[2], 2 * 1024 * 1024);',
      "utf8",
    );
    const judge = {
      ...input.judge,
      harness: {
        name: "command-judge",
        adapter: "command" as const,
        command: {
          argv: [process.execPath, scriptPath, "{judgmentPath}"],
          environmentAllowlist: [],
        },
      },
    };

    const result = await new CommandJudgeAdapter().scoreCandidate({ ...input, judge });

    expect(result.status).toBe("invalid");
    expect(result.rawOutput?.length).toBeLessThan(1000);
    expect((await readFile(input.rawOutputPath)).byteLength).toBeLessThan(1000);
    expect(result.error).toMatch(/exceed|large/i);
  });

  it("validates the separate command awards response against the anonymous cohort", async () => {
    const root = await createTestTempRoot("local-maxima-command-awards-");
    const input = candidateInput(root);
    const awardsInput: JudgeAwardsInput = {
      generationId: input.generationId,
      judgeId: input.judgeId,
      judge: input.judge,
      workspacePath: root,
      promptPath: join(root, "awards-prompt.md"),
      contactSheetPath: input.contactSheetPath,
      judgmentSummaryPath: join(root, "judgment-summary.json"),
      awardsPath: join(root, "awards.json"),
      usageOutputPath: join(root, "awards-usage.json"),
      executionMetadataOutputPath: join(root, "awards-execution-metadata.json"),
      rawOutputPath: join(root, "awards-raw.json"),
      stdoutLogPath: join(root, "awards.stdout.log"),
      stderrLogPath: join(root, "awards.stderr.log"),
      timeoutMs: 1000,
      maximumOutputTokens: 100,
      candidates: [
        {
          anonymousCandidateId: input.anonymousCandidateId,
          judgment: null,
          sanitisedCssPath: input.sanitisedCssPath,
        },
        {
          anonymousCandidateId: "candidate-efgh",
          judgment: null,
          sanitisedCssPath: input.sanitisedCssPath,
        },
      ],
    };
    const awards = {
      schemaVersion: 1,
      generationId: input.generationId,
      judgeId: input.judgeId,
      awards: [
        {
          label: "Cohort Colour Voice",
          anonymousCandidateId: input.anonymousCandidateId,
          rationale: "This entry gives the cohort a distinctive colour voice.",
        },
      ],
    };
    const scriptPath = join(root, "awards-judge.mjs");
    await writeFile(
      scriptPath,
      'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], process.env.AWARDS);',
      "utf8",
    );
    const judge = {
      ...input.judge,
      harness: {
        name: "command-judge",
        adapter: "command" as const,
        command: {
          argv: [
            process.execPath,
            scriptPath,
            "{awardsPath}",
            "{judgmentSummaryPath}",
            "{contactSheetPath}",
          ],
          environmentAllowlist: ["AWARDS"],
        },
      },
    };

    const result = await new CommandJudgeAdapter({
      environment: { AWARDS: JSON.stringify(awards) },
    }).createAwards({ ...awardsInput, judge });

    expect(result.status).toBe("succeeded");
    expect(result.awards?.awards).toEqual(awards.awards);
    expect(await readFile(awardsInput.rawOutputPath, "utf8")).toContain(
      "Cohort Colour Voice",
    );
  });

  it("rejects an oversized sparse awards output before reading or archiving it", async () => {
    const root = await createTestTempRoot("local-maxima-command-awards-sparse-");
    const input = candidateInput(root);
    const awardsInput: JudgeAwardsInput = {
      generationId: input.generationId,
      judgeId: input.judgeId,
      judge: input.judge,
      workspacePath: root,
      promptPath: join(root, "awards-prompt.md"),
      contactSheetPath: input.contactSheetPath,
      judgmentSummaryPath: join(root, "judgment-summary.json"),
      awardsPath: join(root, "awards.json"),
      usageOutputPath: join(root, "awards-usage.json"),
      executionMetadataOutputPath: join(root, "awards-execution-metadata.json"),
      rawOutputPath: join(root, "awards-raw.json"),
      stdoutLogPath: join(root, "awards.stdout.log"),
      stderrLogPath: join(root, "awards.stderr.log"),
      timeoutMs: 1000,
      maximumOutputTokens: 100,
      candidates: [
        {
          anonymousCandidateId: input.anonymousCandidateId,
          judgment: null,
          sanitisedCssPath: input.sanitisedCssPath,
        },
        {
          anonymousCandidateId: "candidate-efgh",
          judgment: null,
          sanitisedCssPath: input.sanitisedCssPath,
        },
      ],
    };
    const scriptPath = join(root, "sparse-awards.mjs");
    await writeFile(
      scriptPath,
      'import { truncateSync, writeFileSync } from "node:fs"; writeFileSync(process.argv[2], ""); truncateSync(process.argv[2], 2 * 1024 * 1024);',
      "utf8",
    );
    const judge = {
      ...input.judge,
      harness: {
        name: "command-judge",
        adapter: "command" as const,
        command: {
          argv: [process.execPath, scriptPath, "{awardsPath}"],
          environmentAllowlist: [],
        },
      },
    };

    const result = await new CommandJudgeAdapter().createAwards({
      ...awardsInput,
      judge,
    });

    expect(result.status).toBe("invalid");
    expect(result.rawOutput?.length).toBeLessThan(1000);
    expect((await readFile(awardsInput.rawOutputPath)).byteLength).toBeLessThan(1000);
    expect(result.error).toMatch(/exceed|large/i);
  });
});

describe("judge execution metadata", () => {
  const VALID_METADATA = {
    schemaVersion: 1,
    observedHarnessVersion: "observed-judge-harness-9.9.9",
    observedModelVersion: "observed-judge-model-8.8.8",
    providerRequestId: "req-judge-private-42",
  };

  function awardsInputFor(root: string, input: JudgeCandidateInput): JudgeAwardsInput {
    return {
      generationId: input.generationId,
      judgeId: input.judgeId,
      judge: input.judge,
      workspacePath: root,
      promptPath: join(root, "awards-prompt.md"),
      contactSheetPath: input.contactSheetPath,
      judgmentSummaryPath: join(root, "judgment-summary.json"),
      awardsPath: join(root, "awards.json"),
      usageOutputPath: join(root, "awards-usage.json"),
      executionMetadataOutputPath: join(root, "awards-execution-metadata.json"),
      rawOutputPath: join(root, "awards-raw.json"),
      stdoutLogPath: join(root, "awards.stdout.log"),
      stderrLogPath: join(root, "awards.stderr.log"),
      timeoutMs: 1000,
      maximumOutputTokens: 100,
      candidates: [
        {
          anonymousCandidateId: input.anonymousCandidateId,
          judgment: null,
          sanitisedCssPath: input.sanitisedCssPath,
        },
        {
          anonymousCandidateId: "candidate-efgh",
          judgment: null,
          sanitisedCssPath: input.sanitisedCssPath,
        },
      ],
    };
  }

  function commandJudge(
    input: JudgeCandidateInput,
    scriptPath: string,
    argv: string[],
    environmentAllowlist: string[] = ["RESPONSE"],
  ) {
    return {
      ...input.judge,
      harness: {
        name: "command-judge",
        adapter: "command" as const,
        command: {
          argv: [process.execPath, scriptPath, ...argv],
          environmentAllowlist,
        },
      },
    };
  }

  it("reads valid candidate and awards execution metadata without changing terminal results", async () => {
    const root = await createTestTempRoot("local-maxima-judge-meta-valid-");
    const input = candidateInput(root);
    const scriptPath = join(root, "meta-judge.mjs");
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[2], process.env.RESPONSE);",
        `writeFileSync(process.argv[3], ${JSON.stringify(JSON.stringify(VALID_METADATA))});`,
      ].join("\n"),
      "utf8",
    );
    const judge = commandJudge(input, scriptPath, [
      "{judgmentPath}",
      "{executionMetadataOutputPath}",
    ]);

    const candidateResult = await new CommandJudgeAdapter({
      environment: { RESPONSE: JSON.stringify(CANDIDATE_RESPONSE) },
    }).scoreCandidate({ ...input, judge });
    expect(candidateResult.status).toBe("succeeded");
    expect(candidateResult.metadataProduced).toBe(true);
    expect(candidateResult.executionMetadata).toEqual({
      observedHarnessVersion: "observed-judge-harness-9.9.9",
      observedModelVersion: "observed-judge-model-8.8.8",
      providerRequestId: "req-judge-private-42",
    });

    const awardsRoot = await createTestTempRoot("local-maxima-judge-meta-awards-");
    const awardsInput = awardsInputFor(awardsRoot, input);
    const awardsScriptPath = join(awardsRoot, "meta-awards.mjs");
    await writeFile(
      awardsScriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[2], process.env.AWARDS);",
        `writeFileSync(process.argv[3], ${JSON.stringify(JSON.stringify(VALID_METADATA))});`,
      ].join("\n"),
      "utf8",
    );
    const awardsJudge = commandJudge(
      input,
      awardsScriptPath,
      ["{awardsPath}", "{executionMetadataOutputPath}"],
      ["AWARDS"],
    );
    const awardsResult = await new CommandJudgeAdapter({
      environment: {
        AWARDS: JSON.stringify({
          schemaVersion: 1,
          generationId: input.generationId,
          judgeId: input.judgeId,
          awards: [],
        }),
      },
    }).createAwards({ ...awardsInput, judge: awardsJudge, workspacePath: awardsRoot });
    expect(awardsResult.status).toBe("succeeded");
    expect(awardsResult.metadataProduced).toBe(true);
    expect(awardsResult.executionMetadata.providerRequestId).toBe(
      "req-judge-private-42",
    );
  });

  it("treats missing judge execution metadata as allowed and never changes the terminal result", async () => {
    const root = await createTestTempRoot("local-maxima-judge-meta-missing-");
    const input = candidateInput(root);
    const scriptPath = join(root, "plain-judge.mjs");
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[2], process.env.RESPONSE);",
      ].join("\n"),
      "utf8",
    );
    const judge = commandJudge(input, scriptPath, ["{judgmentPath}"]);

    const result = await new CommandJudgeAdapter({
      environment: { RESPONSE: JSON.stringify(CANDIDATE_RESPONSE) },
    }).scoreCandidate({ ...input, judge });

    expect(result.status).toBe("succeeded");
    expect(result.attemptCount).toBe(1);
    expect(result.error).toBeNull();
    expect(result.metadataProduced).toBe(false);
    expect(result.executionMetadata).toEqual({
      observedHarnessVersion: null,
      observedModelVersion: null,
      providerRequestId: null,
    });
  });

  it("bounds invalid or oversized judge metadata as incomplete without retry or crash", async () => {
    for (const [name, body] of [
      ["invalid", 'writeFileSync(process.argv[3], "{ not valid metadata");'],
      [
        "oversized",
        'writeFileSync(process.argv[3], ""); truncateSync(process.argv[3], 2 * 1024 * 1024);',
      ],
    ] as const) {
      const root = await createTestTempRoot(`local-maxima-judge-meta-${name}-`);
      const input = candidateInput(root);
      const scriptPath = join(root, `${name}-meta-judge.mjs`);
      await writeFile(
        scriptPath,
        [
          'import { truncateSync, writeFileSync } from "node:fs";',
          "writeFileSync(process.argv[2], process.env.RESPONSE);",
          body,
        ].join("\n"),
        "utf8",
      );
      const judge = commandJudge(input, scriptPath, [
        "{judgmentPath}",
        "{executionMetadataOutputPath}",
      ]);
      let spawns = 0;
      const result = await new CommandJudgeAdapter({
        environment: { RESPONSE: JSON.stringify(CANDIDATE_RESPONSE) },
        spawnProcess: (executable, arguments_, options) => {
          spawns += 1;
          return spawn(executable, arguments_, options);
        },
      }).scoreCandidate({ ...input, judge });

      // Handled, not fatal: the judgment itself stays successful on one call.
      expect(result.status).toBe("succeeded");
      expect(result.attemptCount).toBe(1);
      expect(spawns).toBe(1);
      // Equivalent to the contestant contract: the wrapper produced a file,
      // but the strict bounded read keeps every observed field explicitly
      // null and notes the bounded incompleteness.
      expect(result.metadataProduced).toBe(true);
      expect(result.executionMetadata).toEqual({
        observedHarnessVersion: null,
        observedModelVersion: null,
        providerRequestId: null,
      });
      expect(result.error).toMatch(/execution metadata/i);
      expect(result.error!.length).toBeLessThan(2000);
    }
  });

  it("writes deterministic offline fixture judge metadata for both operations", async () => {
    const root = await createTestTempRoot("local-maxima-judge-fixture-meta-");
    const input = candidateInput(root);
    await writeFile(
      input.sanitisedCssPath,
      ":root { --fixture-style: editorial; }",
      "utf8",
    );
    const adapter = new FixtureJudgeAdapter({ delayMs: 1 });

    const first = await adapter.scoreCandidate(input);
    expect(first.status).toBe("succeeded");
    expect(first.metadataProduced).toBe(true);
    expect(first.executionMetadata.observedHarnessVersion).not.toBeNull();
    expect(first.executionMetadata.observedModelVersion).not.toBeNull();
    expect(first.executionMetadata.providerRequestId).toContain("candidate-abcd");
    const firstBytes = await readFile(input.executionMetadataOutputPath, "utf8");
    expect(
      ExecutionMetadataFileSchema.parse(JSON.parse(firstBytes) as unknown),
    ).toEqual({
      schemaVersion: 1,
      ...first.executionMetadata,
    });
    const second = await adapter.scoreCandidate(input);
    expect(await readFile(input.executionMetadataOutputPath, "utf8")).toBe(firstBytes);
    expect(second.executionMetadata).toEqual(first.executionMetadata);

    const awardsInput = awardsInputFor(root, input);
    const awardsResult = await adapter.createAwards(awardsInput);
    expect(awardsResult.status).toBe("succeeded");
    expect(awardsResult.metadataProduced).toBe(true);
    const awardsBytes = await readFile(awardsInput.executionMetadataOutputPath, "utf8");
    expect(
      ExecutionMetadataFileSchema.parse(JSON.parse(awardsBytes) as unknown),
    ).toEqual({
      schemaVersion: 1,
      ...awardsResult.executionMetadata,
    });
    const awardsAgain = await adapter.createAwards(awardsInput);
    expect(await readFile(awardsInput.executionMetadataOutputPath, "utf8")).toBe(
      awardsBytes,
    );
    expect(awardsAgain.executionMetadata).toEqual(awardsResult.executionMetadata);
  });
});
