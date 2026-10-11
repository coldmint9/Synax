import { describe, expect, it } from "vitest";
import { projectCodeResult } from "./results.js";
import { CODE_INLINE_BYTES } from "./contracts.js";

describe("Code Mode context delivery", () => {
  it("preserves concrete evidence beyond the old 4000-character cut-off", () => {
    const value = "source line\n".repeat(900) + "LAST-LINE";
    const projected = projectCodeResult({ status: "completed", value, nestedCalls: ["PRIVATE"], stdout: "PRIVATE" }, "call-1");
    expect(projected).toEqual({ status: "completed", value });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  });

  it.each(["中😀", "\u0000\n\"\\"])("bounds the serialized envelope and keeps a retrievable reference for %j", (text) => {
    const value = text.repeat(16000);
    const raw = { status: "completed", value, stdout: "PRIVATE", nestedCalls: ["PRIVATE"] };
    const projected = projectCodeResult(raw, "call-2");
    expect(projected).toMatchObject({ status: "completed", delivery: "stored", resultRef: { executionId: "call-2", bytes: Buffer.byteLength(JSON.stringify(value)) } });
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(CODE_INLINE_BYTES);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE");
    expect(raw.value).toBe(value);
  });
});
