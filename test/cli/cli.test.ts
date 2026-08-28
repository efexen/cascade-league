import { describe, expect, it } from "vitest";
import { normalizeSeasonId } from "../../src/cli/commands.js";

describe("garden CLI inputs", () => {
  it("accepts the documented three-digit season alias and stores a four-digit ID", () => {
    expect(normalizeSeasonId("001")).toBe("0001");
    expect(normalizeSeasonId("0001")).toBe("0001");
  });

  it("rejects ambiguous season identifiers", () => {
    expect(() => normalizeSeasonId("1")).toThrow();
    expect(() => normalizeSeasonId("01a")).toThrow();
    expect(() => normalizeSeasonId("00001")).toThrow();
  });
});
