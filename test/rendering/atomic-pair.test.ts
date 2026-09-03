import { rename, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { publishFilePairAtomically } from "../../src/rendering/atomic-pair.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

describe("atomic paired-file publication", () => {
  it("restores both previous outputs when publishing the second file fails", async () => {
    const root = await createTestTempRoot("cascade-atomic-pair-");
    const firstDestinationPath = join(root, "screenshot.png");
    const secondDestinationPath = join(root, "screenshot-viewport.png");
    const firstTemporaryPath = join(root, "full.tmp.png");
    const secondTemporaryPath = join(root, "viewport.tmp.png");
    await Promise.all([
      writeFile(firstDestinationPath, "old full"),
      writeFile(secondDestinationPath, "old viewport"),
      writeFile(firstTemporaryPath, "new full"),
      writeFile(secondTemporaryPath, "new viewport"),
    ]);

    await expect(
      publishFilePairAtomically(
        {
          firstTemporaryPath,
          firstDestinationPath,
          secondTemporaryPath,
          secondDestinationPath,
        },
        {
          moveFile: async (source, destination) => {
            if (source === secondTemporaryPath) {
              throw new Error("injected second publication failure");
            }
            await rename(source, destination);
          },
        },
      ),
    ).rejects.toThrow("injected second publication failure");

    await expect(readFile(firstDestinationPath, "utf8")).resolves.toBe("old full");
    await expect(readFile(secondDestinationPath, "utf8")).resolves.toBe("old viewport");
    expect((await readdir(root)).some((name) => name.includes(".backup-"))).toBe(false);
  });

  it("rejects aliased destinations without changing the existing output", async () => {
    const root = await createTestTempRoot("cascade-atomic-pair-alias-");
    const destinationPath = join(root, "screenshot.png");
    const firstTemporaryPath = join(root, "full.tmp.png");
    const secondTemporaryPath = join(root, "viewport.tmp.png");
    await Promise.all([
      writeFile(destinationPath, "old full"),
      writeFile(firstTemporaryPath, "new full"),
      writeFile(secondTemporaryPath, "new viewport"),
    ]);

    await expect(
      publishFilePairAtomically({
        firstTemporaryPath,
        firstDestinationPath: destinationPath,
        secondTemporaryPath,
        secondDestinationPath: destinationPath,
      }),
    ).rejects.toThrow("paired output paths must be distinct");

    await expect(readFile(destinationPath, "utf8")).resolves.toBe("old full");
  });

  it("removes orphan backups when a restore-from-backup itself fails", async () => {
    const root = await createTestTempRoot("cascade-atomic-pair-restore-");
    const firstDestinationPath = join(root, "screenshot.png");
    const secondDestinationPath = join(root, "screenshot-viewport.png");
    const firstTemporaryPath = join(root, "full.tmp.png");
    const secondTemporaryPath = join(root, "viewport.tmp.png");
    await Promise.all([
      writeFile(firstDestinationPath, "old full"),
      writeFile(secondDestinationPath, "old viewport"),
      writeFile(firstTemporaryPath, "new full"),
      writeFile(secondTemporaryPath, "new viewport"),
    ]);

    await expect(
      publishFilePairAtomically(
        {
          firstTemporaryPath,
          firstDestinationPath,
          secondTemporaryPath,
          secondDestinationPath,
        },
        {
          moveFile: async (source, destination) => {
            if (source === secondTemporaryPath) {
              throw new Error("injected second publication failure");
            }
            if (String(source).includes(".backup-")) {
              throw new Error("injected restore failure");
            }
            await rename(source, destination);
          },
        },
      ),
    ).rejects.toThrow();

    expect((await readdir(root)).some((name) => name.includes(".backup-"))).toBe(false);
  });
});
