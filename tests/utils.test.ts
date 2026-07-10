import { describe, expect, test } from "bun:test";
import { normalizeTopic, safeFilePart } from "../src/utils";

describe("text helpers", () => {
  test("normalizes whitespace", () => {
    expect(normalizeTopic("  Искусственный   интеллект \n в медицине ")).toBe(
      "Искусственный интеллект в медицине",
    );
  });

  test("creates a safe file name", () => {
    expect(safeFilePart("ИИ: польза / риски?")).toBe("ии-польза-риски");
  });

  test("uses fallback for punctuation-only names", () => {
    expect(safeFilePart("???")).toBe("result");
  });
});

