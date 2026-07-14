import { describe, expect, test } from "bun:test";
import {
  createAdvancedFieldKeyboard,
  createAdvancedSectionKeyboard,
  createPresentationSelectionKeyboard,
} from "../src/keyboard";

describe("presentation keyboards", () => {
  const labels = (rows: ReturnType<typeof createAdvancedSectionKeyboard>["build"] extends () => infer Result ? Result : never): string[] => (
    rows.flat().map((button) => typeof button === "string" ? button : button.text)
  );

  test("offers saved IDs without empty rows", () => {
    const rows = createPresentationSelectionKeyboard([{ id: "abc123" }, { id: "def456" }, { id: "ghi789" }]).build();
    expect(rows.every((row) => row.length > 0)).toBeTrue();
    expect(labels(rows)).toContain("ID abc123");
    expect(labels(rows)).toContain("✅ Завершить изменения");
  });

  test("offers all sections and local edit fields", () => {
    const sections = labels(createAdvancedSectionKeyboard().build());
    const fields = labels(createAdvancedFieldKeyboard().build());
    expect(sections.filter((label) => label.startsWith("Раздел "))).toHaveLength(8);
    expect(fields).toContain("📝 Заголовок раздела");
    expect(fields).toContain("📄 Текст раздела");
    expect(fields).toContain("🖼 Фото раздела");
  });
});
