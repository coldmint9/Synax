import { describe, expect, it } from "vitest";
import {
  buildSessionTitlePrompt,
  parseSessionTitleGeneration,
} from "../session-title-llm.js";

const json = (value: unknown) => JSON.stringify(value);

describe("parseSessionTitleGeneration", () => {
  it("reads the json contract", () => {
    expect(
      parseSessionTitleGeneration(
        json({ title: "修复登录", intentCategory: "缺陷修复" }),
      ),
    ).toEqual({ title: "修复登录", intentCategory: "缺陷修复" });
  });

  it("reads json wrapped in a fenced block", () => {
    const text = [
      "```json",
      json({ title: "修复登录", intentCategory: "缺陷修复" }),
      "```",
    ].join("\n");
    expect(parseSessionTitleGeneration(text)).toEqual({
      title: "修复登录",
      intentCategory: "缺陷修复",
    });
  });

  it("keeps the title when a model ignores the json instruction", () => {
    expect(parseSessionTitleGeneration("  修复登录  ")).toEqual({
      title: "修复登录",
      intentCategory: null,
    });
  });

  it("drops a category that breaks the 2-10 character rule", () => {
    expect(
      parseSessionTitleGeneration(
        json({ title: "修复登录", intentCategory: "修" }),
      ),
    ).toMatchObject({ title: "修复登录", intentCategory: null });
    expect(
      parseSessionTitleGeneration(
        json({ title: "修复登录", intentCategory: "这是一个过长的意图分类标签" }),
      ),
    ).toMatchObject({ intentCategory: null });
  });

  it("returns null for empty or title-less answers", () => {
    expect(parseSessionTitleGeneration(null)).toBeNull();
    expect(parseSessionTitleGeneration("   ")).toBeNull();
    expect(parseSessionTitleGeneration(json({ intentCategory: "缺陷修复" }))).toBeNull();
    expect(parseSessionTitleGeneration(json({ title: "   " }))).toBeNull();
  });

  it("reuses the workspace spelling of a label it already publishes", () => {
    expect(
      parseSessionTitleGeneration(
        json({ title: "修复登录", intentCategory: "bugfix" }),
        ["Bugfix", "缺陷修复"],
      ),
    ).toEqual({ title: "修复登录", intentCategory: "Bugfix" });
  });

  it("keeps a label the workspace has not used yet", () => {
    expect(
      parseSessionTitleGeneration(
        json({ title: "修复登录", intentCategory: "性能优化" }),
        ["缺陷修复"],
      ),
    ).toEqual({ title: "修复登录", intentCategory: "性能优化" });
  });
});

describe("buildSessionTitlePrompt", () => {
  it("asks for the title and the intent category only", () => {
    const prompt = buildSessionTitlePrompt("修复登录");
    expect(prompt).toContain('"intentCategory"');
    expect(prompt).not.toMatch(/requirement/i);
    expect(prompt).toContain("2-10 Chinese characters");
    expect(prompt).toContain("修复登录");
  });

  it("offers the labels the workspace already uses", () => {
    const prompt = buildSessionTitlePrompt("修复登录", ["缺陷修复", "需求澄清"]);
    expect(prompt).toContain("Prefer one of them verbatim");
    expect(prompt).toContain("- 缺陷修复");
    expect(prompt).toContain("- 需求澄清");
  });

  it("omits the vocabulary block on a workspace without labels", () => {
    expect(buildSessionTitlePrompt("修复登录", [])).not.toContain(
      "Prefer one of them verbatim",
    );
  });
});
