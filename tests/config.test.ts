import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("reads BOT_TOKEN", () => {
    expect(loadConfig({ BOT_TOKEN: " token " }).botToken).toBe("token");
  });

  test("supports legacy TOKEN", () => {
    expect(loadConfig({ TOKEN: "legacy" }).botToken).toBe("legacy");
  });

  test("fails without a token", () => {
    expect(() => loadConfig({})).toThrow("BOT_TOKEN");
  });
});

