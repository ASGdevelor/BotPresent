import { describe, expect, test } from "bun:test";
import {
  isCompleteLeadCriteria,
  nextLeadField,
  normalizeLeadAnswer,
} from "../src/lead-form";

describe("lead form", () => {
  test("moves through all five fields", () => {
    expect(nextLeadField("whoCanBuy")).toBe("whoToFind");
    expect(nextLeadField("whoToFind")).toBe("whereToSearch");
    expect(nextLeadField("whereToSearch")).toBe("offer");
    expect(nextLeadField("offer")).toBe("exclusions");
    expect(nextLeadField("exclusions")).toBeUndefined();
  });

  test("normalizes and limits an answer", () => {
    expect(normalizeLeadAnswer("  отделы   продаж \n Москва ")).toBe("отделы продаж Москва");
    expect(normalizeLeadAnswer("x".repeat(700))).toHaveLength(500);
  });

  test("recognizes a complete criteria object", () => {
    expect(isCompleteLeadCriteria({ whoCanBuy: "компании" })).toBeFalse();
    expect(isCompleteLeadCriteria({
      whoCanBuy: "компании",
      whoToFind: "интеграторы",
      whereToSearch: "Москва",
      offer: "автоматизация",
      exclusions: "нет",
    })).toBeTrue();
  });
});

