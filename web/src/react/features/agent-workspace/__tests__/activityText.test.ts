import { describe, expect, it } from "vitest";
import {
  ACTIVITY_BODY_LIMIT,
  activityPreview,
  formatCharCount,
  tailForDisplay,
  thinkingBannerPhrase,
  thinkingBannerPhrases,
} from "../activityText";

describe("formatCharCount", () => {
  it("keeps small counts exact and compacts large ones", () => {
    expect(formatCharCount(0)).toBe("0");
    expect(formatCharCount(812)).toBe("812");
    expect(formatCharCount(7_240)).toBe("7.2k");
    expect(formatCharCount(99_332)).toBe("99.3k");
    expect(formatCharCount(123_456)).toBe("123k");
  });
});

describe("activityPreview", () => {
  it("flattens the first non-empty line and truncates it", () => {
    expect(activityPreview("\n\nLet me check   the state.\nsecond line")).toBe(
      "Let me check the state.",
    );
    expect(activityPreview("x".repeat(200))).toHaveLength(90);
    expect(activityPreview("x".repeat(200)).endsWith("…")).toBe(true);
  });
});

describe("tailForDisplay", () => {
  it("returns the body untouched below the limit", () => {
    expect(tailForDisplay("short")).toEqual({ text: "short", hidden: 0 });
  });

  it("keeps the tail of an oversized body and reports what it hid", () => {
    const content = "a".repeat(ACTIVITY_BODY_LIMIT) + "TAIL";
    const { text, hidden } = tailForDisplay(content);
    expect(hidden).toBe(4);
    expect(text.startsWith("a")).toBe(true);
    expect(text.endsWith("TAIL")).toBe(true);
    expect(text).toHaveLength(ACTIVITY_BODY_LIMIT);
  });
});

describe("thinkingBannerPhrase", () => {
  it("strips the markers of a headline-only reasoning block", () => {
    expect(thinkingBannerPhrase("**Inspecting backend metadata**")).toBe(
      "Inspecting backend metadata",
    );
    expect(thinkingBannerPhrase("  **检查后端元数据**  ")).toBe(
      "检查后端元数据",
    );
  });

  it("keeps an unterminated headline stable while it streams", () => {
    expect(thinkingBannerPhrase("**Inspect")).toBe("Inspect");
    expect(thinkingBannerPhrase("**Inspecting backend metadata*")).toBe(
      "Inspecting backend metadata",
    );
  });

  it("leaves ordinary reasoning to the expandable row", () => {
    expect(thinkingBannerPhrase("")).toBeNull();
    expect(thinkingBannerPhrase("Let me check the state.")).toBeNull();
    expect(thinkingBannerPhrase("**Bold** and then a paragraph.")).toBeNull();
    expect(
      thinkingBannerPhrase("**Heading**\nmore reasoning below"),
    ).toBeNull();
    expect(thinkingBannerPhrase("****")).toBeNull();
  });

  it("treats a paragraph-length bold payload as reasoning, not a headline", () => {
    expect(thinkingBannerPhrase(`**${"x".repeat(200)}**`)).toBeNull();
  });
});

describe("thinkingBannerPhrases", () => {
  it("splits adjacent headline chunks with or without whitespace", () => {
    expect(
      thinkingBannerPhrases(
        "**Designing layout****Planning animation****Verifying output**",
      ),
    ).toEqual(["Designing layout", "Planning animation", "Verifying output"]);
    expect(thinkingBannerPhrases("**First**\n\n**Second**")).toEqual([
      "First",
      "Second",
    ]);
  });

  it("accepts an in-flight final chunk while streaming", () => {
    expect(thinkingBannerPhrases("**First****Second")).toEqual([
      "First",
      "Second",
    ]);
    expect(thinkingBannerPhrases("**First****Second*")).toEqual([
      "First",
      "Second",
    ]);
  });

  it("rejects a sequence when ordinary reasoning is mixed in", () => {
    expect(
      thinkingBannerPhrases("**First** then ordinary reasoning"),
    ).toBeNull();
    expect(thinkingBannerPhrases("**First**\nordinary reasoning")).toBeNull();
  });
});
