import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  appendBoundedChunk,
  boundedUtf8,
  runBoundedCommand,
  writeLog,
} from "../../src/contestants/support.js";

describe("bounded private output", () => {
  it("redacts a secret prefix at a truncation boundary and keeps the final log within its byte cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-log-boundary-"));
    const logPath = join(root, "output.log");

    await writeLog(logPath, [Buffer.from("super")], ["supersecret"], 5);

    const written = await readFile(logPath);
    expect(written.byteLength).toBeLessThanOrEqual(5);
    expect(written.toString("utf8")).not.toContain("super");
    expect(Buffer.from(written.toString("utf8"), "utf8").equals(written)).toBe(true);
  });

  it("redacts secrets split across captured chunks before truncating UTF-8 output", () => {
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    capturedBytes = appendBoundedChunk(
      chunks,
      capturedBytes,
      Buffer.from("prefix supe"),
      20,
      Buffer.byteLength("supersecret", "utf8"),
    );
    appendBoundedChunk(
      chunks,
      capturedBytes,
      Buffer.from("rsecret suffix 😀"),
      20,
      Buffer.byteLength("supersecret", "utf8"),
    );

    const result = boundedUtf8(chunks, 20, ["supersecret"]);
    expect(result).not.toContain("supersecret");
    expect(result).not.toContain("supe");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(20);
  });

  it("does not expose either side of a secret cut off at any UTF-8 byte boundary", () => {
    for (const limit of [0, 1, 5, 10, 19, 20, 21]) {
      const result = boundedUtf8([Buffer.from("prefix supersecret suffix 😀")], limit, [
        "supersecret",
      ]);
      expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(limit);
      expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
      for (let length = 3; length < "supersecret".length; length += 1) {
        expect(result).not.toContain("supersecret".slice(0, length));
        expect(result).not.toContain("supersecret".slice(-length));
      }
    }
  });

  it("does not expose a configured secret from the truncation marker", () => {
    const result = boundedUtf8([Buffer.from("x".repeat(100))], 64, [
      "[output truncated]",
    ]);

    expect(result).not.toContain("[output truncated]");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(64);
  });

  it("settles and terminates a child that emits an error without close", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-maxima-command-error-"));
    const child = Object.assign(new EventEmitter(), {
      pid: 424242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;

    const result = await Promise.race([
      runBoundedCommand({
        argv: ["/absolute/mocked-command"],
        cwd: root,
        env: {},
        timeoutMs: 1000,
        terminationGraceMs: 10,
        maximumLogBytes: 128,
        stdoutLogPath: join(root, "stdout.log"),
        stderrLogPath: join(root, "stderr.log"),
        redactionValues: ["supersecret"],
        spawnProcess: () => {
          queueMicrotask(() =>
            child.emit("error", new Error("spawn failed supersecret")),
          );
          return child;
        },
      }),
      new Promise<null>((resolvePromise) =>
        setTimeout(() => resolvePromise(null), 500),
      ),
    ]);

    expect(result).not.toBeNull();
    expect(result && "error" in result ? result.error : null).toContain("spawn failed");
    expect(result && "error" in result ? result.error : null).not.toContain(
      "supersecret",
    );
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
