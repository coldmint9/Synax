import { describe, expect, it } from "vitest";
import { capabilityDirectory, searchCapabilities } from "./search.js";
import type { CapabilityTool } from "./disclosure.js";

function tool(id: string, description: string, label = id): CapabilityTool {
  return { id, label, description, category: "mcp", mutability: "read", resumeBehavior: "none" };
}

describe("capability retrieval", () => {
  it("ranks keyword coverage above a partial name match", () => {
    const partial = tool("mcp.a.browser", "Browse items");
    const full = tool("mcp.b.capture", "Capture a screenshot", "Chrome browser");
    expect(searchCapabilities([partial, full], "browser screenshot")).toEqual([full, partial]);
  });
  it("searches camelCase names, Unicode and progressive details", () => {
    const read = { ...tool("mcp.docs.searchFiles", "查找文件"), progressiveDetails: "Includes full-page images" };
    expect(searchCapabilities([read], " FILES search ")).toEqual([read]);
    expect(searchCapabilities([read], "查找文件")).toEqual([read]);
    expect(searchCapabilities([read], "full page")).toEqual([read]);
  });
  it("keeps exact ID order without duplicates or search filtering", () => {
    const a = tool("mcp.a.read", "read");
    const b = tool("mcp.b.read", "read");
    expect(searchCapabilities([a, b], "unknown", "unknown", [b.id, a.id, b.id])).toEqual([b, a]);
  });
  it("bounds directory examples independently of the number of tools", () => {
    const entries = Array.from({ length: 100 }, (_, index) => tool(`mcp.docs.read_${index}`, "read"));
    expect(capabilityDirectory(entries)[0]).toMatchObject({ group: "mcp.docs", count: 100 });
    expect(capabilityDirectory(entries)[0].examples).toHaveLength(3);
  });
});
