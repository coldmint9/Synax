import { describe, expect, it } from "vitest";
import { resolveDocumentLink } from "../fileLink";

describe("links written inside a workspace document", () => {
  it.each([
    ["./2026-10-23-baseline.md", "docs/investigations/2026-10-23-baseline.md"],
    ["2026-10-23-baseline.md", "docs/investigations/2026-10-23-baseline.md"],
    ["../src/a.ts", "docs/src/a.ts"],
    ["./guide/intro.md#usage", "docs/investigations/guide/intro.md"],
    ["../../README.md", "README.md"],
  ])("resolves %s against the document's own folder", (href, path) => {
    expect(
      resolveDocumentLink(href, "docs/investigations/plan.md", "reference"),
    ).toEqual({
      kind: "file",
      target: { path, line: null, rootId: "reference" },
    });
  });

  it("carries a line suffix and a line fragment", () => {
    expect(resolveDocumentLink("a.ts:12", "src/plan.md")).toEqual({
      kind: "file",
      target: { path: "src/a.ts", line: 12 },
    });
    expect(resolveDocumentLink("./a.ts#L42", "src/plan.md")).toEqual({
      kind: "file",
      target: { path: "src/a.ts", line: 42 },
    });
  });

  it.each([
    "#usage",
    "https://example.com/plan.md",
    "mailto:team@example.com",
    "javascript:alert(1)",
    "vscode://file/src/a.ts",
    "//cdn.example.com/a.ts",
  ])("leaves %s to the browser", (href) => {
    expect(resolveDocumentLink(href, "docs/plan.md")).toEqual({
      kind: "external",
    });
  });

  it.each([
    "../../outside.md",
    "/Users/repo/plan.md",
    "file:///Users/repo/plan.md",
    "C:/repo/plan.md",
    "%2E%2E%2F%2E%2E/outside.md",
  ])("intercepts %s without resolving it to a workspace path", (href) => {
    expect(resolveDocumentLink(href, "docs/plan.md")).toEqual({
      kind: "unresolved",
    });
  });
});
