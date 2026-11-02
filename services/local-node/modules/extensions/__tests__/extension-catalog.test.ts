import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ local: vi.fn(), remote: vi.fn() }));
vi.mock("../local-source.js", () => ({ localExtensionSource: mocks.local }));
vi.mock("../remote-source.js", () => ({
  remoteCatalogItems: mocks.remote,
  remoteExtensionSources: () => [],
}));
vi.mock("../../agent-runtime/tool-registry.js", () => ({
  toolRegistry: { list: () => [] },
}));
vi.mock("../../skills/skill-registry.js", () => ({
  skillRegistry: { listSummaries: () => [] },
}));
vi.mock("../../skills/skill-source-service.js", () => ({
  skillSourceService: { listSources: () => [] },
}));
vi.mock(
  "../../../infrastructure/runtime/config/project-settings-store.js",
  () => ({ getProjectSettings: () => ({ mcpServers: [] }) }),
);
vi.mock("../extension-store.js", () => ({
  extensionStore: {
    definitions: () => [],
    state: (_project: string, _kind: string, _id: string, state: unknown) =>
      state,
  },
}));
import { listExtensions } from "../extension-catalog.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.remote.mockReturnValue([]);
  mocks.local.mockReturnValue({
    tools: [],
    skills: [],
    warnings: ["Tool manifest is invalid"],
    locations: [
      {
        kind: "skill",
        status: "error",
        path: "/skills",
        message: "Skill directory unavailable",
      },
      {
        kind: "mcp",
        status: "error",
        path: "/mcp",
        message: "MCP configuration invalid",
      },
    ],
    mcp: {
      servers: [],
      unsupported: [{ name: "Remote MCP", reason: "Unsupported transport" }],
    },
  });
});

describe("local extension catalog scope", () => {
  it.each([
    ["tool", ["Tool manifest is invalid"]],
    ["skill", ["/skills: Skill directory unavailable"]],
    [
      "mcp",
      ["/mcp: MCP configuration invalid", "Remote MCP: Unsupported transport"],
    ],
  ] as const)("shows only %s discovery warnings", async (kind, warnings) => {
    const result = await listExtensions("project-a", {
      view: "market",
      source: "local",
      kind,
    });
    expect(result.warnings).toEqual(warnings);
    expect(mocks.remote).not.toHaveBeenCalled();
  });
  it("keeps all discovery warnings for legacy mixed catalogs", async () => {
    const result = await listExtensions("project-a", {
      view: "market",
      source: "local",
    });
    expect(result.warnings).toHaveLength(4);
  });
  it("does not scan local files for installed and built-in views", async () => {
    await listExtensions("project-a", { view: "installed", kind: "tool" });
    await listExtensions("project-a", {
      view: "market",
      source: "builtin",
      kind: "tool",
    });
    expect(mocks.local).not.toHaveBeenCalled();
    expect(mocks.remote).not.toHaveBeenCalled();
  });
});
