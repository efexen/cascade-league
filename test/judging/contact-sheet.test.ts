import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { buildAnonymousContactSheet } from "../../src/judging/contact-sheet.js";
import { ContactSheetOrderSchema } from "../../src/schemas/index.js";
import { createTestTempRoot } from "../helpers/temp-roots.js";

describe("anonymous contact sheets", () => {
  it("builds a deterministic 1600×900 sheet with anonymous labels and fitted cells", async () => {
    const root = await createTestTempRoot("local-maxima-contact-sheet-");
    const screenshots = await Promise.all(
      ["#cc5544", "#3366aa", "#449966"].map(async (background, index) => {
        const path = join(root, `candidate-${index + 1}.png`);
        await sharp({
          create: { width: 1280, height: 2400, channels: 4, background },
        })
          .png()
          .toFile(path);
        return path;
      }),
    );
    const candidates = screenshots.map((screenshotPath, index) => ({
      anonymousCandidateId: `candidate-${String.fromCharCode(97 + index)}1234`,
      validationStatus: "valid" as const,
      screenshotPath,
    }));
    const orderPath = join(root, "contact-sheet-order.json");
    const firstPath = join(root, "first.png");
    const secondPath = join(root, "second.png");

    const first = await buildAnonymousContactSheet({
      generationId: "0001",
      judgeId: "fixture-judge",
      candidates,
      outputPath: firstPath,
      orderPath,
      seed: randomBytes(32).toString("hex"),
    });
    const second = await buildAnonymousContactSheet({
      generationId: "0001",
      judgeId: "fixture-judge",
      candidates,
      outputPath: secondPath,
      orderPath: join(root, "second-order.json"),
      seed: first.seed,
    });

    expect(first.candidateOrder).not.toEqual(
      candidates.map((entry) => entry.anonymousCandidateId),
    );
    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    expect(second.candidateOrder).toEqual(first.candidateOrder);
    expect(
      ContactSheetOrderSchema.parse(
        JSON.parse(await readFile(orderPath, "utf8")) as unknown,
      ),
    ).toMatchObject({
      generationId: "0001",
      judgeId: "fixture-judge",
      seed: first.seed,
      candidateOrder: first.candidateOrder,
    });
    const metadata = await sharp(firstPath).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1600);
    expect(metadata.height).toBe(900);
    const pixels = await sharp(firstPath).removeAlpha().raw().toBuffer();
    const containsRgb = (red: number, green: number, blue: number): boolean => {
      for (let index = 0; index < pixels.length; index += 3) {
        if (
          pixels[index] === red &&
          pixels[index + 1] === green &&
          pixels[index + 2] === blue
        ) {
          return true;
        }
      }
      return false;
    };
    expect(containsRgb(0xcc, 0x55, 0x44)).toBe(true);
    expect(containsRgb(0x33, 0x66, 0xaa)).toBe(true);
    expect(containsRgb(0x44, 0x99, 0x66)).toBe(true);
    const text = await sharp(firstPath).raw().toBuffer();
    expect(text.byteLength).toBeGreaterThan(0);
    await mkdir(join(root, "unused"), { recursive: true });
    await writeFile(join(root, "unused/identity.txt"), "Contestant identity", "utf8");
  });

  it("removes the temporary contact sheet when the final rename fails", async () => {
    const root = await createTestTempRoot("local-maxima-contact-sheet-failure-");
    const screenshotPath = join(root, "candidate.png");
    await sharp({
      create: { width: 1280, height: 2400, channels: 4, background: "#3366aa" },
    })
      .png()
      .toFile(screenshotPath);
    const outputPath = join(root, "sheet.png");
    await mkdir(outputPath);

    await expect(
      buildAnonymousContactSheet({
        generationId: "0001",
        judgeId: "fixture-judge",
        candidates: [
          {
            anonymousCandidateId: "candidate-abcd",
            validationStatus: "valid",
            screenshotPath,
          },
        ],
        outputPath,
        seed: "fixed-seed",
      }),
    ).rejects.toThrow();
    expect(await readdir(root)).not.toContain("sheet.png.tmp");
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith("sheet.png.tmp-")),
    ).toEqual([]);
  });

  it("removes an order artifact when contact-sheet construction fails after ordering", async () => {
    const root = await createTestTempRoot("local-maxima-contact-order-failure-");
    const screenshotPath = join(root, "candidate.png");
    await sharp({
      create: { width: 1280, height: 2400, channels: 4, background: "#3366aa" },
    })
      .png()
      .toFile(screenshotPath);
    const outputPath = join(root, "sheet.png");
    const orderPath = join(root, "sheet-order.json");
    await mkdir(outputPath);

    await expect(
      buildAnonymousContactSheet({
        generationId: "0001",
        judgeId: "fixture-judge",
        candidates: [
          {
            anonymousCandidateId: "candidate-abcd",
            validationStatus: "valid",
            screenshotPath,
          },
        ],
        outputPath,
        orderPath,
        seed: "fixed-seed",
      }),
    ).rejects.toThrow();
    await expect(readFile(orderPath)).rejects.toThrow();
  });

  it("preserves existing contact-sheet artifacts when a rebuild fails", async () => {
    const root = await createTestTempRoot("local-maxima-contact-preserve-");
    const outputPath = join(root, "sheet.png");
    const orderPath = join(root, "sheet-order.json");
    await writeFile(outputPath, "previous sheet", "utf8");
    await writeFile(orderPath, "previous order", "utf8");

    await expect(
      buildAnonymousContactSheet({
        generationId: "0001",
        judgeId: "fixture-judge",
        candidates: [
          {
            anonymousCandidateId: "candidate-abcd",
            validationStatus: "valid",
            screenshotPath: join(root, "missing.png"),
          },
        ],
        outputPath,
        orderPath,
        seed: "fixed-seed",
      }),
    ).rejects.toThrow();
    expect(await readFile(outputPath, "utf8")).toBe("previous sheet");
    expect(await readFile(orderPath, "utf8")).toBe("previous order");
  });
});
