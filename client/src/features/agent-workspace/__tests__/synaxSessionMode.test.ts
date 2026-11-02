import { describe, expect, it } from "vitest";
import { readSynaxSessionMode } from "../synaxSessionTypes";

describe("readSynaxSessionMode", () => {
  it("keeps the stored super mode instead of falling back to chat", () => {
    expect(readSynaxSessionMode({ mode: "super" })).toBe("super");
  });

  it("keeps the existing modes", () => {
    expect(readSynaxSessionMode({ mode: "plan" })).toBe("plan");
    expect(readSynaxSessionMode({ mode: "goal" })).toBe("goal");
    expect(readSynaxSessionMode({ mode: "plan_node" })).toBe("plan_node");
  });

  it("falls back to chat for a missing or unknown mode", () => {
    expect(readSynaxSessionMode(null)).toBe("chat");
    expect(readSynaxSessionMode({ mode: "supercoding" })).toBe("chat");
  });
});
