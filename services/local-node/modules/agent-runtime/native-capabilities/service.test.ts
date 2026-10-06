import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";
import { asSchema } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { ToolRegistry } from "../tool-registry.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { resetAgentRuntimeFixtures } from "../__tests__/agent-runtime-fixtures.js";
import { setSessionWorkspaceRoot, clearSessionWorkspaceRoot } from "../tools/workspace.js";
import { updateProjectSettings, initializeProjectSettings, getProjectSettings } from "../../../infrastructure/runtime/config/project-settings-store.js";
import { buildLoopToolSet } from "../loop-ai-tools.js";
import { countTokens } from "../context-tokenizer.js";
import { capabilityContract, disclose, readDisclosure, DISCLOSURE_LIMITS } from "./disclosure.js";
import type { RegisteredTool } from "../contracts.js";

let registry: ToolRegistry, id: string, dir: string;
const projectId = "native-capability-test";
function tool(index: number): RegisteredTool {
  return {
    id: `mcp.fixture.read_${index}`, label: `Read ${index}`, category: "mcp", mutability: "read", resumeBehavior: "none",
    codeModeReadOnly: true,
    description: `Read fixture ${index} with a path, filter and output limit. Return the matching records.`,
    inputSchema: z.object({ path: z.string().describe("Relative path inside the workspace"), filter: z.string().optional(), limit: z.number().optional() }),
    execute: () => ({ result: { ok: true, index }, displaySummary: "Read fixture", artifacts: [] }),
  };
}
const project = () => registry.capabilities.project(id, registry.listForSession(id));
const discover = async (ids: string[]) => (await registry.execute(id, "agent.discover", { ids })).toolResult?.result as { contracts: Array<{ id: string; compose: boolean }> };
const run = async (code: string) => (await registry.execute(id, "agent.execute", { code })).toolResult?.result as { status: string; value?: unknown; error?: string };

beforeEach(() => {
  vi.stubEnv("SYNAX_NATIVE_CAPABILITIES", "1");
  resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  vi.stubEnv("SYNAX_NATIVE_CAPABILITIES", "1");
  registry = new ToolRegistry();
  id = agentSessionRuntime.create({ projectId, profileId: "synax", prompt: "Capability test", permissionTier: "unrestricted" }).id;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-native-capabilities-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  setSessionWorkspaceRoot(id, dir);
  updateProjectSettings(projectId, { codeMode: { enabled: true, mcpTools: [tool(0).id] } }, "test");
  registry.register(tool(0));
});
afterEach(() => { vi.unstubAllEnvs(); clearSessionWorkspaceRoot(id); fs.rmSync(dir, { recursive: true, force: true }); });

describe("native capability lifecycle", () => {
  it("initializes only new projects and preserves existing composition policy", () => {
    const fresh = initializeProjectSettings("native-new-project");
    expect(fresh.schemaVersion).toBe(2);
    expect(fresh.codeMode).toEqual({ enabled: true, mcpTools: [] });
    updateProjectSettings("native-existing-project", { codeMode: { enabled: false, mcpTools: ["mcp.docs.read"] } }, "test");
    expect(initializeProjectSettings("native-existing-project").codeMode).toEqual({ enabled: false, mcpTools: ["mcp.docs.read"] });
    expect(getProjectSettings("native-old-unconfigured").codeMode?.enabled).toBe(false);
    vi.stubEnv("SYNAX_NATIVE_CAPABILITIES", "0");
    expect(initializeProjectSettings("native-legacy-new-project").codeMode?.enabled).toBe(false);
  });
  it("keeps common reads and native execution available without discovery", async () => {
    const ids = project().tools.map((item) => item.id);
    expect(ids).toContain("file.read");
    expect(ids).toContain("agent.discover");
    expect(ids).toContain("agent.execute");
    expect(ids).not.toContain("code.run");
    expect(ids).not.toContain("code.tools");
    expect(ids).not.toContain("file.write");
    const result = await run('const result = await tools.call("file.read", {path:"a.txt"}); return { read: Boolean(result) };');
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ read: true });
  });

  it("discovers contracts but does not execute them until the next projection", async () => {
    project();
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {path:"a"})`)).status).toBe("failed");
    expect((await discover([tool(0).id])).contracts[0].compose).toBe(true);
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {path:"a"})`)).status).toBe("failed");
    expect(project().tools.map((item) => item.id)).toContain(tool(0).id);
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {path:"a"})`)).status).toBe("completed");
  });

  it("rehydrates contracts after restart and summary-only history", async () => {
    await discover([tool(0).id]);
    registry = new ToolRegistry();
    registry.register(tool(0));
    expect(project().tools.map((item) => item.id)).toContain(tool(0).id);
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {path:"a"})`)).status).toBe("completed");
  });

  it("invalidates changed schemas and checks grants again at execution", async () => {
    await discover([tool(0).id]);
    project();
    registry.register({ ...tool(0), inputSchema: z.object({ changed: z.boolean() }) });
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {changed:true})`)).status).toBe("failed");
    expect(project().tools.map((item) => item.id)).not.toContain(tool(0).id);
    await discover([tool(0).id]);
    project();
    updateProjectSettings(projectId, { codeMode: { mcpTools: [] } }, "test");
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {changed:true})`)).status).toBe("denied");
  });

  it("keeps discovery independent of composition permission and supports rollback", async () => {
    updateProjectSettings(projectId, { codeMode: { enabled: false } }, "test");
    const projected = project();
    expect(projected.tools.map((item) => item.id)).toContain("agent.discover");
    expect(projected.tools.map((item) => item.id)).not.toContain("agent.execute");
    expect(projected.prompt).toContain("Composition is disabled");
    await discover(["file.write"]);
    expect(project().tools.map((item) => item.id)).toContain("file.write");
    expect((await discover(["file.write"])).contracts[0].compose).toBe(false);
    vi.stubEnv("SYNAX_NATIVE_CAPABILITIES", "0");
    expect(project().prompt).toBe("");
    expect(project().tools.map((item) => item.id)).toContain("file.write");
  });

  it("honors the global kill switch and excludes external backends", () => {
    vi.stubEnv("SYNAX_CODE_MODE", "0");
    expect(project().tools.map((item) => item.id)).not.toContain("agent.execute");
    store.updateSessionMetadata(id, { backend: { id: "acp" } });
    expect(project().tools.map((item) => item.id)).not.toContain("agent.discover");
    expect(project().prompt).toBe("");
  });

  it("rejects inherited disclosure state for a different session", async () => {
    await discover([tool(0).id]);
    const state = store.getSession(id).sessionMetadata?.capabilityDisclosure;
    expect(readDisclosure(state, "different-child").entries).toEqual([]);
  });

  it("pages through the full directory without a matching search term", async () => {
    for (let index = 1; index < 10; index++) registry.register(tool(index));
    const found: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const result = (await registry.execute(id, "agent.discover", { group: "mcp.fixture", cursor })).toolResult?.result as { contracts: Array<{ id: string }>; nextCursor: number | null };
      found.push(...result.contracts.map((item) => item.id));
      cursor = result.nextCursor;
    }
    expect(new Set(found).size).toBe(10);
  });

  it("bounds dynamic working sets by count and tokens and preserves recent additions", () => {
    const all = new Map(Array.from({ length: 30 }, (_, index) => {
      const contract = capabilityContract(tool(index), true);
      return [contract.id, contract] as const;
    }));
    let state = readDisclosure(null, id);
    for (const contract of all.values()) state = disclose(state, [contract], all);
    expect(state.entries.length).toBeLessThanOrEqual(DISCLOSURE_LIMITS.count);
    expect(state.entries.some((item) => item.id === tool(29).id)).toBe(true);
    expect(state.entries.reduce((sum, item) => sum + all.get(item.id)!.tokens, 0)).toBeLessThanOrEqual(DISCLOSURE_LIMITS.tokens);
  });

  it("reduces first-request schema tokens by at least 50% for 100 extra tools", async () => {
    for (let index = 0; index < 100; index++) registry.register(tool(index));
    const serialize = async (definitions: ReturnType<ToolRegistry["listForSession"]>) => {
      const { tools } = buildLoopToolSet(definitions);
      return JSON.stringify(await Promise.all(Object.entries(tools).map(async ([name, value]) => ({
        name, description: value.description, inputSchema: await asSchema(value.inputSchema).jsonSchema,
      }))));
    };
    const full = countTokens(await serialize(registry.listForSession(id).filter((tool) => !["agent.discover", "agent.execute"].includes(tool.id))));
    const reduced = countTokens(await serialize(project().tools));
    expect(reduced / full).toBeLessThanOrEqual(0.5);
    console.info("capability-schema-baseline", { full, reduced, ratio: reduced / full });
  });
});
