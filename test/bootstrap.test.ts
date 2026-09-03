import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("repository bootstrap", () => {
  it("keeps Node 24 as the reference and supports Node 22+", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as {
      name?: string;
      engines?: { node?: string };
      scripts?: Record<string, string>;
    };

    expect(packageJson.name).toBe("cascade-league");
    expect(readFileSync(join(repositoryRoot, ".nvmrc"), "utf8").trim()).toMatch(
      /^24(?:\.\d+\.\d+)?$/,
    );
    expect(packageJson.engines?.node).toBe(">=22");
    expect(packageJson.scripts).toMatchObject({
      garden: expect.any(String),
      test: expect.any(String),
      verify: expect.any(String),
      typecheck: expect.any(String),
      lint: expect.any(String),
      format: expect.any(String),
    });
  });
});
