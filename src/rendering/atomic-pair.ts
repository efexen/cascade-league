import { lstat, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

interface PublishFilePairInput {
  readonly firstTemporaryPath: string;
  readonly firstDestinationPath: string;
  readonly secondTemporaryPath: string;
  readonly secondDestinationPath: string;
}

export interface PublishFilePairOptions {
  readonly moveFile?: typeof rename;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function publishFilePairAtomically(
  input: PublishFilePairInput,
  options: PublishFilePairOptions = {},
): Promise<void> {
  if (resolve(input.firstDestinationPath) === resolve(input.secondDestinationPath)) {
    throw new Error("paired output paths must be distinct");
  }

  const moveFile = options.moveFile ?? rename;
  const suffix = `.backup-${process.pid}-${randomBytes(8).toString("hex")}`;
  const firstBackupPath = `${input.firstDestinationPath}${suffix}`;
  const secondBackupPath = `${input.secondDestinationPath}${suffix}`;
  let firstBackedUp = false;
  let secondBackedUp = false;
  let firstPublished = false;
  let secondPublished = false;

  try {
    if (await exists(input.firstDestinationPath)) {
      await moveFile(input.firstDestinationPath, firstBackupPath);
      firstBackedUp = true;
    }
    if (await exists(input.secondDestinationPath)) {
      await moveFile(input.secondDestinationPath, secondBackupPath);
      secondBackedUp = true;
    }
    await moveFile(input.firstTemporaryPath, input.firstDestinationPath);
    firstPublished = true;
    await moveFile(input.secondTemporaryPath, input.secondDestinationPath);
    secondPublished = true;
  } catch (publicationError) {
    const rollbackErrors: unknown[] = [];
    if (secondPublished) {
      await rm(input.secondDestinationPath, { force: true }).catch((error: unknown) =>
        rollbackErrors.push(error),
      );
    }
    if (firstPublished) {
      await rm(input.firstDestinationPath, { force: true }).catch((error: unknown) =>
        rollbackErrors.push(error),
      );
    }
    if (secondBackedUp) {
      try {
        await moveFile(secondBackupPath, input.secondDestinationPath);
        secondBackedUp = false;
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (firstBackedUp) {
      try {
        await moveFile(firstBackupPath, input.firstDestinationPath);
        firstBackedUp = false;
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [publicationError, ...rollbackErrors],
        "paired output publication failed and rollback was incomplete",
      );
    }
    throw publicationError;
  } finally {
    if (firstBackedUp)
      await rm(firstBackupPath, { force: true }).catch(() => undefined);
    if (secondBackedUp)
      await rm(secondBackupPath, { force: true }).catch(() => undefined);
  }
}
