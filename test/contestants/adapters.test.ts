import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FixtureContestantAdapter,
  CommandContestantAdapter,
  materializeContestantArgv,
  type ContestantRunInput,
} from "../../src/contestants/index.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

function fixtureInput(root: string): ContestantRunInput {
  return {
    generationId: "0001",
    contestantId: "fixture-editorial",
    anonymousCandidateId: "candidate-abcd",
    contestant: {
      id: "fixture-editorial",
      displayName: "Fixture Editorial",
      harness: {
        name: "fixture-harness",
        version: "1.0.0",
        adapter: "fixture",
        fixture: "editorial",
      },
      model: {
        provider: "local-fixture",
        name: "editorial-model",
        version: "1.0.0",
      },
      enabled: true,
    },
    workspacePath: root,
    challengePath: join(root, "challenge.html"),
    starterCssPath: join(root, "starter.css"),
    promptPath: join(root, "prompt.md"),
    submissionPath: join(root, "submission.css"),
    usageOutputPath: join(root, "usage.json"),
    stdoutLogPath: join(root, "stdout.log"),
    stderrLogPath: join(root, "stderr.log"),
    timeoutMs: 1000,
    maximumTotalTokens: 100,
  };
}

describe("fixture contestant adapter", () => {
  it("copies the named fixture stylesheet once and reports success", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-contestant-"));
    const fixtureRoot = join(root, "fixtures");
    const workspaceRoot = join(root, "workspace");
    const input = fixtureInput(workspaceRoot);
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(join(fixtureRoot, "editorial.css"), "body { color: red; }\n");

    const result = await new FixtureContestantAdapter({ fixtureRoot }).run(input);

    expect(result.status).toBe("succeeded");
    expect(result.attemptCount).toBe(1);
    expect(await readFile(input.submissionPath, "utf8")).toBe("body { color: red; }\n");
  });

  it.each([
    ["no-submission", "missing_submission"],
    ["failure", "failed"],
    ["timeout", "timeout"],
  ] as const)(
    "models a terminal %s outcome without retrying",
    async (fixture, status) => {
      const root = await mkdtemp(join(tmpdir(), `local-maxima-fixture-${fixture}-`));
      const fixtureRoot = join(root, "fixtures");
      const workspaceRoot = join(root, "workspace");
      await mkdir(fixtureRoot, { recursive: true });
      const input = fixtureInput(workspaceRoot);
      const contestant = {
        ...input.contestant,
        harness: { ...input.contestant.harness, fixture },
      };

      const result = await new FixtureContestantAdapter({
        fixtureRoot,
        delayMs: 1,
      }).run({
        ...input,
        contestant,
        timeoutMs: fixture === "timeout" ? 1 : input.timeoutMs,
      });

      expect(result.status).toBe(status);
      expect(result.attemptCount).toBe(1);
      expect(result.submissionProduced).toBe(false);
    },
  );

  it("includes the deterministic render-failure fixture stylesheet", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-fixture-render-failure-"));
    const input = fixtureInput(join(root, "workspace"));
    const contestant = {
      ...input.contestant,
      harness: { ...input.contestant.harness, fixture: "render-failure" },
    };

    const result = await new FixtureContestantAdapter({
      fixtureRoot: join(repositoryRoot, "test/fixtures/contestants"),
    }).run({ ...input, contestant });

    expect(result.status).toBe("succeeded");
    expect(await readFile(input.submissionPath, "utf8")).toContain("min-width: 2000px");
  });
});

describe("command contestant adapter", () => {
  it("rejects embedded placeholders instead of templating arbitrary argv text", () => {
    expect(() =>
      materializeContestantArgv(["--output={submissionPath}"], {
        workspacePath: "/tmp/workspace",
        challengePath: "/tmp/challenge.html",
        starterCssPath: "/tmp/starter.css",
        promptPath: "/tmp/prompt.md",
        submissionPath: "/tmp/submission.css",
        usageOutputPath: "/tmp/usage.json",
      }),
    ).toThrow(/placeholder/i);
  });

  it("materializes complete placeholders and passes only the explicit environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-command-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const scriptPath = join(root, "contestant.mjs");
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], "body { color: blue; }\\n");',
        "writeFileSync(process.argv[3], JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), visible: process.env.VISIBLE_SECRET ?? null, hidden: process.env.HIDDEN_SECRET ?? null }));",
      ].join("\n"),
      "utf8",
    );
    const input = fixtureInput(workspacePath);
    const contestant = {
      ...input.contestant,
      harness: {
        name: "command-harness",
        version: "1.0.0",
        adapter: "command" as const,
        command: {
          argv: [
            process.execPath,
            scriptPath,
            "{submissionPath}",
            "{usageOutputPath}",
            "{challengePath}",
          ],
          environmentAllowlist: ["VISIBLE_SECRET"],
        },
      },
    };

    const result = await new CommandContestantAdapter({
      environment: {
        VISIBLE_SECRET: "visible-value",
        HIDDEN_SECRET: "hidden-value",
      },
    }).run({ ...input, contestant });

    expect(result.status).toBe("succeeded");
    const observed = JSON.parse(await readFile(input.usageOutputPath, "utf8")) as {
      cwd: string;
      argv: string[];
      visible: string | null;
      hidden: string | null;
    };
    expect(observed.cwd).toBe(await realpath(workspacePath));
    expect(observed.argv).toEqual([
      input.submissionPath,
      input.usageOutputPath,
      input.challengePath,
    ]);
    expect(observed.visible).toBe("visible-value");
    expect(observed.hidden).toBeNull();
    expect(await readFile(input.submissionPath, "utf8")).toBe(
      "body { color: blue; }\n",
    );
  });

  it("uses shell:false when spawning an absolute executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-shell-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const scriptPath = join(root, "contestant.mjs");
    await writeFile(
      scriptPath,
      'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "body {}\\n");',
      "utf8",
    );
    const input = fixtureInput(workspacePath);
    const contestant = {
      ...input.contestant,
      harness: {
        name: "command-harness",
        adapter: "command" as const,
        command: {
          argv: [process.execPath, scriptPath, "{submissionPath}"],
          environmentAllowlist: [],
        },
      },
    };
    let seenShell: boolean | undefined;
    const result = await new CommandContestantAdapter({
      spawnProcess: (executable, arguments_, options) => {
        seenShell = options.shell;
        return spawn(executable, arguments_, options);
      },
    }).run({ ...input, contestant });

    expect(result.status).toBe("succeeded");
    expect(seenShell).toBe(false);
  });

  it("terminates a hung process with TERM followed by KILL", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-timeout-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const scriptPath = join(root, "hung-contestant.mjs");
    await writeFile(
      scriptPath,
      'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 10);',
      "utf8",
    );
    const input = fixtureInput(workspacePath);
    const contestant = {
      ...input.contestant,
      harness: {
        name: "command-harness",
        adapter: "command" as const,
        command: {
          argv: [process.execPath, scriptPath],
          environmentAllowlist: [],
        },
      },
    };

    const result = await new CommandContestantAdapter({ terminationGraceMs: 30 }).run({
      ...input,
      contestant,
      timeoutMs: 100,
    });

    expect(result.status).toBe("timeout");
    expect(result.timedOut).toBe(true);
    expect(result.terminationSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("kills a real contestant process group, including a grandchild holding stdio, before the hard deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-process-tree-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const pidPath = join(root, "pids.txt");
    const scriptPath = join(root, "tree-contestant.mjs");
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
    const input = fixtureInput(workspacePath);
    const contestant = {
      ...input.contestant,
      harness: {
        name: "command-harness",
        adapter: "command" as const,
        command: {
          argv: [process.execPath, scriptPath, pidPath],
          environmentAllowlist: [],
        },
      },
    };

    const startedAt = Date.now();
    const result = await Promise.race([
      new CommandContestantAdapter({ terminationGraceMs: 30 }).run({
        ...input,
        contestant,
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

  it("bounds and redacts private process logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-redaction-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const scriptPath = join(root, "noisy-contestant.mjs");
    await writeFile(
      scriptPath,
      [
        'console.log("secret-token " + process.env.SECRET_TOKEN + " " + "x".repeat(100));',
        'console.error("secret-token " + process.env.SECRET_TOKEN + " " + "x".repeat(100));',
        'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "body {}\\n");',
      ].join("\n"),
      "utf8",
    );
    const input = fixtureInput(workspacePath);
    const contestant = {
      ...input.contestant,
      harness: {
        name: "command-harness",
        adapter: "command" as const,
        command: {
          argv: [process.execPath, scriptPath, "{submissionPath}"],
          environmentAllowlist: ["SECRET_TOKEN"],
        },
      },
    };

    await new CommandContestantAdapter({
      environment: { SECRET_TOKEN: "secret-token" },
      maximumLogBytes: 64,
    }).run({ ...input, contestant });

    const stdout = await readFile(input.stdoutLogPath, "utf8");
    const stderr = await readFile(input.stderrLogPath, "utf8");
    expect(stdout).not.toContain("secret-token");
    expect(stderr).not.toContain("secret-token");
    expect(stdout).toContain("[output truncated]");
    expect(stderr).toContain("[output truncated]");
    expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(stderr, "utf8")).toBeLessThanOrEqual(64);
  });
});
