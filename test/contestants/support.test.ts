import { EventEmitter } from "node:events";
import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  appendBoundedChunk,
  boundedUtf8,
  runBoundedCommand,
  writeLog,
} from "../../src/contestants/support.js";
import {
  DEFAULT_EXECUTION_METADATA_LIMIT_BYTES,
  ExecutionMetadataFileSchema,
  readExecutionMetadataFile,
} from "../../src/contestants/support.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

const emptyMetadata = {
  observedHarnessVersion: null,
  observedModelVersion: null,
  providerRequestId: null,
};

describe("execution metadata file schema", () => {
  it("accepts a complete record, an all-null record, and partial observed fields", () => {
    expect(
      ExecutionMetadataFileSchema.parse({
        schemaVersion: 1,
        observedHarnessVersion: "harness-2.1.0",
        observedModelVersion: "model-4.5.1",
        providerRequestId: "req-abc-123",
      }),
    ).toEqual({
      schemaVersion: 1,
      observedHarnessVersion: "harness-2.1.0",
      observedModelVersion: "model-4.5.1",
      providerRequestId: "req-abc-123",
    });
    expect(
      ExecutionMetadataFileSchema.parse({
        schemaVersion: 1,
        observedHarnessVersion: null,
        observedModelVersion: null,
        providerRequestId: null,
      }),
    ).toBeTruthy();
    expect(
      ExecutionMetadataFileSchema.parse({
        schemaVersion: 1,
        observedHarnessVersion: "harness-2.1.0",
        observedModelVersion: null,
        providerRequestId: null,
      }),
    ).toBeTruthy();
  });

  it("rejects blank values, over-long values, wrong version, and unknown keys", () => {
    expect(() =>
      ExecutionMetadataFileSchema.parse({
        schemaVersion: 1,
        observedHarnessVersion: "   ",
        observedModelVersion: null,
        providerRequestId: null,
      }),
    ).toThrow();
    expect(() =>
      ExecutionMetadataFileSchema.parse({
        schemaVersion: 1,
        observedHarnessVersion: "x".repeat(201),
        observedModelVersion: null,
        providerRequestId: null,
      }),
    ).toThrow();
    expect(() =>
      ExecutionMetadataFileSchema.parse({
        schemaVersion: 1,
        observedHarnessVersion: null,
        observedModelVersion: null,
        providerRequestId: "r".repeat(257),
      }),
    ).toThrow();
    expect(() =>
      ExecutionMetadataFileSchema.parse({
        schemaVersion: 2,
        observedHarnessVersion: null,
        observedModelVersion: null,
        providerRequestId: null,
      }),
    ).toThrow();
    expect(() =>
      ExecutionMetadataFileSchema.parse({
        schemaVersion: 1,
        observedHarnessVersion: null,
        observedModelVersion: null,
        providerRequestId: null,
        secret: "leak",
      }),
    ).toThrow();
  });
});

describe("readExecutionMetadataFile", () => {
  it("returns the parsed metadata for a valid file", async () => {
    const root = await createTestTempRoot("local-maxima-exec-meta-");
    const path = join(root, "execution-metadata.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        observedHarnessVersion: "harness-9",
        observedModelVersion: "model-9",
        providerRequestId: "request-9",
      }),
      "utf8",
    );

    const result = await readExecutionMetadataFile(path);

    expect(result).toEqual({
      metadata: {
        observedHarnessVersion: "harness-9",
        observedModelVersion: "model-9",
        providerRequestId: "request-9",
      },
      exists: true,
      error: null,
    });
  });

  it("returns null metadata without error when the file is missing", async () => {
    const root = await createTestTempRoot("local-maxima-exec-meta-missing-");
    const result = await readExecutionMetadataFile(join(root, "absent.json"));
    expect(result).toEqual({ metadata: emptyMetadata, exists: false, error: null });
  });

  it("reports a bounded error and null metadata for invalid JSON, unknown keys, and oversized files", async () => {
    const root = await createTestTempRoot("local-maxima-exec-meta-invalid-");

    const invalidPath = join(root, "invalid.json");
    await writeFile(invalidPath, "{ not json", "utf8");
    const invalid = await readExecutionMetadataFile(invalidPath);
    expect(invalid.metadata).toEqual(emptyMetadata);
    expect(invalid.exists).toBe(true);
    expect(invalid.error).toMatch(/invalid/i);

    const unknownKeyPath = join(root, "unknown.json");
    await writeFile(
      unknownKeyPath,
      JSON.stringify({
        schemaVersion: 1,
        observedHarnessVersion: null,
        observedModelVersion: null,
        providerRequestId: null,
        extra: true,
      }),
      "utf8",
    );
    const unknown = await readExecutionMetadataFile(unknownKeyPath);
    expect(unknown.metadata).toEqual(emptyMetadata);
    expect(unknown.exists).toBe(true);
    expect(unknown.error).toMatch(/invalid/i);

    const oversizedPath = join(root, "oversized.json");
    await writeFile(
      oversizedPath,
      `${JSON.stringify({
        schemaVersion: 1,
        observedHarnessVersion: null,
        observedModelVersion: null,
        providerRequestId: "x",
      })}${" ".repeat(DEFAULT_EXECUTION_METADATA_LIMIT_BYTES + 16)}`,
      "utf8",
    );
    const oversized = await readExecutionMetadataFile(oversizedPath);
    expect(oversized.metadata).toEqual(emptyMetadata);
    expect(oversized.exists).toBe(true);
    expect(oversized.error).toMatch(/exceed|limit/i);
  });

  it("reports a bounded error for a symlinked metadata file", async () => {
    const root = await createTestTempRoot("local-maxima-exec-meta-symlink-");
    const targetPath = join(root, "real.json");
    const linkPath = join(root, "execution-metadata.json");
    await writeFile(
      targetPath,
      JSON.stringify({
        schemaVersion: 1,
        observedHarnessVersion: "harness-1",
        observedModelVersion: "model-1",
        providerRequestId: "request-1",
      }),
      "utf8",
    );
    await symlink(targetPath, linkPath);

    const result = await readExecutionMetadataFile(linkPath);

    expect(result.metadata).toEqual(emptyMetadata);
    expect(result.exists).toBe(true);
    expect(result.error).toMatch(/regular file/i);
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  });
});

describe("bounded private output", () => {
  it("redacts a secret prefix at a truncation boundary and keeps the final log within its byte cap", async () => {
    const root = await createTestTempRoot("local-maxima-log-boundary-");
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
    const root = await createTestTempRoot("local-maxima-command-error-");
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
