import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { formatToolInputError } from "./tool-input-error.js";

function parseFailure(schema: z.ZodTypeAny, value: unknown): unknown {
  try {
    schema.parse(value);
    throw new Error("expected schema.parse to fail");
  } catch (error) {
    return error;
  }
}

describe("formatToolInputError", () => {
  it("reports multiple bounded issues with paths, codes, limits, and recovery advice", () => {
    const error = parseFailure(
      z.object({
        contextLines: z.number().int().max(5),
        query: z.string().min(1),
        mode: z.enum(["literal", "regex"]),
      }),
      { contextLines: 8, query: "", mode: "unknown" },
    );

    const result = formatToolInputError("rg", {
      contextLines: 8,
      query: "",
      mode: "unknown",
    }, error);

    expect(result).toBeDefined();
    expect(result).toContain("rg");
    expect(result).toContain("too_big");
    expect(result).toContain("contextLines");
    expect(result).toContain("received 8");
    expect(result).toContain("maximum 5");
    expect(result).toContain("minimum 1");
    expect(result).toContain("invalid_value");
    expect(result).toContain("mode");
  });

  it("does not echo long or sensitive write content and gives semantic split guidance", () => {
    const secret = "TOP-SECRET-token-" + "x".repeat(5000);
    const error = parseFailure(
      z.object({ content: z.string().max(32) }),
      { content: secret },
    );

    const result = formatToolInputError("file.write", { content: secret }, error);

    expect(result).toBeDefined();
    expect(result).not.toContain(secret);
    expect(result).not.toContain("TOP-SECRET");
    expect(result).toContain("content");
    expect(result).toContain("maximum 32");
    expect(result).toContain("shrink the write scope");
    expect(result).toContain("split it into semantic operations");
    expect(result).toContain("do not silently truncate");
    expect(result!.length).toBeLessThanOrEqual(1_400);
  });

  it("bounds issue count and total diagnostic length", () => {
    const schema = z.object(Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `field${index}`,
        z.string().min(10_000),
      ]),
    ));
    const error = parseFailure(schema, Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field${index}`, ""]),
    ));

    const result = formatToolInputError("tool.with.a.long.argument.schema", {}, error);

    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(1_400);
    expect(result).toContain("additional validation issue(s) omitted");
    expect(result).toContain("field0");
    expect(result).not.toContain("field19");
  });

  it("accepts a structurally confirmed cross-realm Zod error but leaves other errors to the caller", () => {
    const confirmed = {
      name: "ZodError",
      issues: [{ code: "too_big", path: ["count"], maximum: 2, origin: "number", message: "not used" }],
    };

    expect(formatToolInputError("tool", { count: 3 }, confirmed)).toContain("too_big");
    expect(formatToolInputError("tool", {}, new Error("caller-owned error"))).toBeUndefined();
    expect(formatToolInputError("tool", {}, { issues: [{ code: "too_big", path: [], message: "not enough" }] })).toBeUndefined();
    expect(formatToolInputError("tool", {}, "not an error")).toBeUndefined();
  });

  it("keeps safe explanations for custom constraints without echoing raw values", () => {
    const error = parseFailure(
      z.object({
        byteOffset: z.number().int().min(0),
        expectedRevision: z.string().optional(),
      }).superRefine((value, context) => {
        if (value.byteOffset > 0 && !value.expectedRevision) {
          context.addIssue({ code: "custom", path: ["expectedRevision"], message: "internal message must not be echoed" });
        }
      }),
      { byteOffset: 4 },
    );
    const result = formatToolInputError("file.read", { byteOffset: 4 }, error);
    expect(result).toContain("custom");
    expect(result).toContain("non-zero byteOffset");
    expect(result).not.toContain("internal message");
  });
});
