import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const trackedRoots = new Set<string>();

export async function createTestTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  trackedRoots.add(root);
  return root;
}

export function __trackTestTempRootForCleanupTestOnly(root: string): void {
  trackedRoots.add(root);
}

/** Recursively restore owner rwX without following symlinks. */
async function restoreWritable(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        return;
      }
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        await restoreWritable(full);
        try {
          await chmod(full, 0o755);
        } catch {
          /* best effort */
        }
      } else {
        try {
          await chmod(full, 0o644);
        } catch {
          /* best effort */
        }
      }
    }),
  );
  try {
    await chmod(dir, 0o755);
  } catch {
    /* best effort */
  }
}

export async function cleanupTrackedTestTempRoots(): Promise<void> {
  const roots = [...trackedRoots];
  const failures: Array<{ root: string; error: unknown }> = [];
  try {
    for (const root of roots) {
      try {
        try {
          await restoreWritable(root);
        } catch {
          /* proceed to rm so real failures surface there */
        }
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        // Tolerate already-missing roots (force:true normally covers this,
        // but keep an explicit guard for cross-platform ENOENT races).
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") continue;
        failures.push({ root, error });
      }
    }
    if (failures.length > 0) {
      const detail = failures.map((f) => `${f.root}: ${String(f.error)}`).join("; ");
      throw new Error(`Failed to clean up test temp roots: ${detail}`);
    }
  } finally {
    for (const root of roots) trackedRoots.delete(root);
  }
}
