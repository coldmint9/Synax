import { describe, expect, it } from "vitest";
import { normalizeIntentCategory } from "../session-classification.js";

describe("normalizeIntentCategory", () => {
  it("keeps labels inside the 2-10 character contract", () => {
    expect(normalizeIntentCategory("缺陷修复")).toBe("缺陷修复");
    expect(normalizeIntentCategory("一二三四五六七八九十")).toBe(
      "一二三四五六七八九十",
    );
    expect(normalizeIntentCategory("  bugfix  ")).toBe("bugfix");
  });

  it("rejects labels that are too short, too long or not text", () => {
    expect(normalizeIntentCategory("修")).toBeNull();
    expect(normalizeIntentCategory("一二三四五六七八九十一")).toBeNull();
    expect(normalizeIntentCategory("")).toBeNull();
    expect(normalizeIntentCategory("   ")).toBeNull();
    expect(normalizeIntentCategory(null)).toBeNull();
    expect(normalizeIntentCategory(42)).toBeNull();
    expect(normalizeIntentCategory("- - -")).toBeNull();
  });

  it.each(["none", "N/A", "unknown", "未分类", "无"])(
    "treats %s as no category",
    (raw) => {
      expect(normalizeIntentCategory(raw)).toBeNull();
    },
  );

  it("strips the decoration models add around a label", () => {
    expect(normalizeIntentCategory('"缺陷修复。"')).toBe("缺陷修复");
    expect(normalizeIntentCategory("「需求澄清」")).toBe("需求澄清");
  });
});
