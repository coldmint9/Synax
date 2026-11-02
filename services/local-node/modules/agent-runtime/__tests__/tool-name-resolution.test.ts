import { describe, expect, it } from "vitest";
import {
  canonicalToolName,
  resolveToolName,
} from "../tool-name-resolution.js";

const tools = [
  "bash",
  "file.delete",
  "file.glob",
  "file.list",
  "file.patch",
  "file.read",
  "file.write",
  "rg",
  "webSearch",
];

describe("tool name resolution", () => {
  it("keeps exact IDs first", () => {
    expect(resolveToolName("file.write", tools)).toEqual({
      match: { toolId: "file.write", basis: "exact" },
      suggestions: [],
    });
  });

  it("resolves provider-safe, namespaced and camelCase spellings", () => {
    expect(canonicalToolName("functions.file.write")).toBe("file_write");
    expect(canonicalToolName("File.Write")).toBe("file_write");
    expect(canonicalToolName("file_write__0123456789abcdef")).toBe("file_write");
    expect(canonicalToolName("webSearch")).toBe("web_search");
    expect(resolveToolName("file_write", tools).match).toEqual({
      toolId: "file.write",
      basis: "canonical",
    });
    expect(resolveToolName("file_write__0123456789abcdef", tools).match).toEqual({
      toolId: "file.write",
      basis: "canonical",
    });
    expect(resolveToolName("web_search", tools).match).toEqual({
      toolId: "webSearch",
      basis: "canonical",
    });
  });

  it("maps the compatibility vocabulary models arrive with", () => {
    for (const [alias, toolId] of [
      ["write", "file.write"],
      ["create_file", "file.write"],
      ["read", "file.read"],
      ["str_replace_editor", "file.patch"],
      ["ls", "file.list"],
      ["shell", "bash"],
    ] as const) {
      expect(resolveToolName(alias, tools).match).toEqual({
        toolId,
        basis: "alias",
      });
    }
  });

  it("does not guess when the same word names a mounted tool", () => {
    const resolution = resolveToolName("write", [
      ...tools,
      "mcp.docs.write",
    ]);
    expect(resolution.match).toBeNull();
    expect(resolution.suggestions).toContain("file.write");
    expect(resolution.suggestions).toContain("mcp.docs.write");
  });

  it("leaves ambiguous canonical names unresolved and names the candidates", () => {
    const resolution = resolveToolName("mcp_srv_a_b", [
      "mcp.srv.a_b",
      "mcp.srv.a.b",
    ]);
    expect(resolution.match).toBeNull();
    expect(resolution.suggestions).toEqual(
      expect.arrayContaining(["mcp.srv.a_b", "mcp.srv.a.b"]),
    );
  });

  it("suggests the closest real tool instead of leaving the model to guess", () => {
    const resolution = resolveToolName("flie.write", tools);
    expect(resolution.match).toBeNull();
    expect(resolution.suggestions[0]).toBe("file.write");
  });

  it("reports no invented candidates for an unrelated name", () => {
    expect(resolveToolName("write", ["bash", "file.read"])).toEqual({
      match: null,
      suggestions: [],
    });
    expect(resolveToolName("describe", tools)).toEqual({
      match: null,
      suggestions: [],
    });
  });

  it("offers the bounded list when no name is similar", () => {
    expect(resolveToolName("", tools).suggestions).toHaveLength(5);
  });
});
