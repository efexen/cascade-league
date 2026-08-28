import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FixtureJudgeAdapter,
  CommandJudgeAdapter,
  type JudgeCandidateInput,
  type JudgeAwardsInput,
} from "../../src/judging/index.js";
import {
  CandidateJudgmentSchema,
  JudgeCandidateResponseSchema,
} from "../../src/schemas/index.js";

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
    stdoutLogPath: join(root, "stdout.log"),
    stderrLogPath: join(root, "stderr.log"),
    timeoutMs: 1000,
    maximumOutputTokens: 100,
  };
}

describe("fixture judge adapter", () => {
  it("emits a strict score response without model usage and a durable judgment with usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-judge-"));
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
    const root = await mkdtemp(join(tmpdir(), "local-maxima-awards-"));
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
    const root = await mkdtemp(join(tmpdir(), "local-maxima-command-judge-"));
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
    const root = await mkdtemp(join(tmpdir(), "local-maxima-command-judge-boundary-"));
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
    const root = await mkdtemp(
      join(tmpdir(), "local-maxima-command-judge-placeholders-"),
    );
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
      expect(argv.slice(1)).toHaveLength(9);
      expect(argv.slice(1).every((value) => value.length > 0)).toBe(true);
      expect(argv.join(" ")).not.toContain("fixture-editorial");
    }
  });

  it("forces a hung judge from TERM to KILL without retrying", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-command-judge-timeout-"));
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
    const root = await mkdtemp(join(tmpdir(), "local-maxima-judge-process-tree-"));
    const pidPath = join(root, "pids.txt");
    const scriptPath = join(root, "tree-judge.mjs");
    const grandchildCode =
      'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 10);';
    await writeFile(
      scriptPath,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], { stdio: "inherit" });`,
        "writeFileSync(process.argv[2], `${process.pid}\\n${grandchild.pid}\\n`);",
        'process.on("SIGTERM", () => undefined);',
        "setInterval(() => undefined, 10);",
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
          argv: [process.execPath, scriptPath, pidPath],
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
    const root = await mkdtemp(join(tmpdir(), "local-maxima-command-judge-invalid-"));
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
    const root = await mkdtemp(join(tmpdir(), "local-maxima-command-judge-sparse-"));
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
    const root = await mkdtemp(join(tmpdir(), "local-maxima-command-awards-"));
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
    const root = await mkdtemp(join(tmpdir(), "local-maxima-command-awards-sparse-"));
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
