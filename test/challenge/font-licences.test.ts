import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fontsDirectory = new URL("../../challenge/season-001/fonts/", import.meta.url)
  .pathname;
const starterCssPath = new URL(
  "../../challenge/season-001/starter.css",
  import.meta.url,
).pathname;

const expectedCopyrights: Record<string, string> = {
  "lm-neutral-sans.ttf":
    "Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)",
  "lm-display-sans.ttf":
    "Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)",
  "lm-readable-serif.ttf":
    "Copyright 2014 The Source Serif 4 Project Authors (https://github.com/adobe-fonts/source-serif)",
  "lm-expressive-serif.ttf":
    "Copyright 2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces)",
  "lm-mono.ttf": 'Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"',
};

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function parseTableRow(row: string): readonly string[] {
  return row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim().replace(/^`|`$/gu, ""));
}

describe("bundled challenge font provenance", () => {
  it("maps every configured font to a readable licence, upstream source, and checksum", async () => {
    const starterCss = await readFile(starterCssPath, "utf8");
    const readme = await readFile(join(fontsDirectory, "README.md"), "utf8");
    const rows = readme
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map(parseTableRow);
    const configuredFonts = [
      ...starterCss.matchAll(
        /font-family:\s*"([^"]+)";\s*\n\s*src:\s*url\("([^"]+)"\)/gu,
      ),
    ].map((match) => ({
      family: match[1]!,
      binary: match[2]!.replace(/^fonts\//u, ""),
    }));

    expect(configuredFonts).toHaveLength(5);
    for (const configuredFont of configuredFonts) {
      const row = rows.find(
        ([family, binary]) =>
          family === configuredFont.family && binary === configuredFont.binary,
      );
      expect(row).toBeDefined();
      const [, binary, licence, checksum, upstream] = row!;
      const licencePath = join(fontsDirectory, licence!);
      const licenceText = await readFile(licencePath, "utf8");

      expect(licenceText.trim().length).toBeGreaterThan(0);
      expect(licenceText.split("\n", 1)[0]).toBe(expectedCopyrights[binary!]!);
      expect(checksum).toBe(await sha256(join(fontsDirectory, binary!)));
      expect(upstream).toMatch(/^https:\/\//u);
    }
  });
});
