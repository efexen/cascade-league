import { describe, expect, it } from "vitest";

import { StaticSiteCatalogSchema } from "../../src/schemas/publication.js";

const first = {
  seasonId: "0001",
  generationId: "0001",
  path: "seasons/0001/0001/index.html",
};
const second = {
  seasonId: "0001",
  generationId: "0002",
  path: "seasons/0001/0002/index.html",
};

describe("static publication catalog schema", () => {
  it("accepts only sorted unique entries with exact derived paths", () => {
    expect(
      StaticSiteCatalogSchema.parse({ schemaVersion: 1, generations: [first, second] }),
    ).toEqual({ schemaVersion: 1, generations: [first, second] });
    expect(
      StaticSiteCatalogSchema.safeParse({
        schemaVersion: 1,
        generations: [{ ...first, path: "other.html" }],
      }).success,
    ).toBe(false);
    expect(
      StaticSiteCatalogSchema.safeParse({
        schemaVersion: 1,
        generations: [first, first],
      }).success,
    ).toBe(false);
    expect(
      StaticSiteCatalogSchema.safeParse({
        schemaVersion: 1,
        generations: [second, first],
      }).success,
    ).toBe(false);
    expect(
      StaticSiteCatalogSchema.safeParse({
        schemaVersion: 1,
        generations: [first],
        privateField: true,
      }).success,
    ).toBe(false);
  });
});
