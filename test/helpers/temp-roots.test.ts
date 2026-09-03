import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTrackedTestTempRoots, createTestTempRoot } from "./temp-roots.js";

describe("temp-roots cleanup primitive", () => {
  it("removes nested read-only files, preserves external symlink targets, tolerates missing roots, is idempotent", async () => {
    // Nested read-only directory/file is removed.
    const root = await createTestTempRoot("cascade-test-");
    const nested = join(root, "nested", "deep");
    mkdirSync(nested, { recursive: true });
    const roFile = join(nested, "snapshot.css");
    writeFileSync(roFile, "a { color: red; }");
    chmodSync(roFile, 0o444);
    chmodSync(nested, 0o000);
    chmodSync(join(root, "nested"), 0o555);

    // Symlink inside root pointing to external sentinel: target must survive.
    const externalDir = mkdtempSync(join(tmpdir(), "cascade-external-"));
    const sentinel = join(externalDir, "sentinel.txt");
    writeFileSync(sentinel, "sentinel");
    const link = join(root, "evil-link");
    symlinkSync(sentinel, link);

    // Missing tracked root tolerated: remove one root before cleanup.
    const root2 = await createTestTempRoot("cascade-test-");
    const { rmSync } = await import("node:fs");
    rmSync(root2, { recursive: true, force: true });
    expect(existsSync(root2)).toBe(false);

    await cleanupTrackedTestTempRoots();

    expect(existsSync(root)).toBe(false);
    expect(existsSync(root2)).toBe(false);
    // External target untouched.
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("sentinel");

    // Repeated cleanup is idempotent.
    await cleanupTrackedTestTempRoots();

    rmSync(externalDir, { recursive: true, force: true });
  });
});
