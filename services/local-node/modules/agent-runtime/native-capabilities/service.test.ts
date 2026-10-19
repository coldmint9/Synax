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
import { buildLoopModelMessages, createLoopHistoryReader } from "../loop-model-messages.js";
import { codeParentId } from "../code-mode/history.js";
import { countTokens } from "../context-tokenizer.js";
import { capabilityContract, disclose, readDisclosure, reconcileDisclosure } from "./disclosure.js";
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

beforeEach(async () => {
  vi.stubEnv("SYNAX_NATIVE_CAPABILITIES", "1");
  await resetAgentRuntimeFixtures();
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
  it.each([1200, 9000])("delivers five complete file reads (%i chars each) and recovers exact evidence without replay", async (size) => {
    const paths = Array.from({ length: 5 }, (_, i) => `source-${i}.ts`);
    const contents = paths.map((_, i) => `export const item${i} = '${"中😀\\\"".repeat(size).slice(0, size)}';\n// tail-${i}`);
    paths.forEach((name, i) => fs.writeFileSync(path.join(dir, name), contents[i]));
    const projection = project();
    expect(projection.tools.some(t => t.id === "code.result")).toBe(true);
    store.appendMessage({ id: "delivery-request", sessionId: id, runId: null, stepId: null, role: "user", content: "Read five files", metadata: { source: "turn_request" }, createdAt: "2026-01-01" });
    store.appendRun({ id: "delivery-run", sessionId: id, triggerMessageId: "delivery-request", status: "completed", startedAt: "2026-01-01", completedAt: null, currentStep: 0, stopReason: null, model: null, metadata: {} });
    store.appendRunStep({ id: "delivery-step", sessionId: id, runId: "delivery-run", index: 0, status: "completed", model: null, startedAt: "2026-01-01", completedAt: "2026-01-01", finishReason: "tool-calls", metadata: {} });
    const executed = await registry.execute(id, "agent.execute", {
      code: `return await Promise.all(${JSON.stringify(paths)}.map(async path => ({path,result:await tools.call('file.read',{path})})));`,
    }, { runId: "delivery-run", stepId: "delivery-step", modelToolCallId: "delivery-call" });
    expect(executed.record.status).toBe("completed");
    const raw = executed.toolResult?.result as { value: Array<{ result: { content: string } }> };
    expect(raw.value.map(row => row.result.content)).toEqual(contents);
    store.appendRunPart({ id: "delivery-part", sessionId: id, runId: "delivery-run", stepId: "delivery-step", kind: "tool_call", sequence: 0, content: "execute", toolCallId: executed.record.id, metadata: {}, createdAt: "2026-01-01" });
    const messages = JSON.stringify(buildLoopModelMessages(store, id, buildLoopToolSet(projection.tools)));
    expect(messages).not.toContain("nestedCalls");
    expect(messages).not.toContain("Tool text truncated");
    if (size === 9000) {
      expect(messages).toContain('"delivery":"stored"');
      expect(messages).toContain(executed.record.id);
      expect(messages).not.toContain("tail-4");
    } else {
      expect(messages).toContain("tail-4");
      expect(messages).not.toContain('"delivery":"stored"');
    }
    // Changing the source proves recovery reads the saved execution, not files.
    fs.writeFileSync(path.join(dir, paths[4]), "changed after execution");
    let recovered = "", offset: number | null = 0;
    while (offset !== null) {
      const page = await registry.execute(id, "code.result", { executionId: executed.record.id, path: ["4", "result", "content"], offset });
      expect(page.record.status).toBe("completed");
      const result = page.toolResult?.result as { content: string; nextOffset: number | null };
      recovered += result.content;
      offset = result.nextOffset;
    }
    expect(recovered).toBe(contents[4]);
    const tail = await registry.execute(id, "code.result", { executionId: executed.record.id, path: ["4", "result", "content"], offset: Math.max(0, contents[4].length - 2000) }, { runId: "delivery-run", stepId: "delivery-step", modelToolCallId: "tail-call" });
    store.appendRunPart({ id: "tail-part", sessionId: id, runId: "delivery-run", stepId: "delivery-step", kind: "tool_call", sequence: 1, content: "read saved tail", toolCallId: tail.record.id, metadata: {}, createdAt: "2026-01-01" });
    store.updateRunStep("delivery-step", { metadata: { contextProjectionVersion: 2, toolContextReceipts: { [tail.record.id]: { version: 1, outputType: "text", text: "STALE-TRUNCATED-RECEIPT" } } } });
    const withPage = JSON.stringify(buildLoopModelMessages(store, id, buildLoopToolSet(projection.tools)));
    expect(withPage).toContain("tail-4");
    expect(withPage).toContain('"nextOffset":null');
    expect(withPage).not.toContain("STALE-TRUNCATED-RECEIPT");
    expect(store.listToolCalls(id).filter(t => t.toolId === "file.read")).toHaveLength(5);
    // The same result reader is available inside a new program for processing.
    expect(await run(`return (await tools.call('code.result',{executionId:${JSON.stringify(executed.record.id)},path:['4','path']})).content;`))
      .toMatchObject({ status: "completed", value: paths[4] });
  });

  it("scopes saved returns to their session and rejects missing paths and non-Code-Mode records", async () => {
    project();
    const execution = await registry.execute(id, "agent.execute", { code: 'return {items:[{text:"saved"}]};' });
    const executionId = execution.record.id;
    for (const args of [{ executionId, path: ["items", "9"] }, { executionId, path: ["toString"] }, { executionId, offset: 9999 }, { executionId: "missing" }]) {
      expect((await registry.execute(id, "code.result", args)).record.status).toBe("failed");
    }
    const direct = await registry.execute(id, "file.read", { path: "a.txt" });
    expect((await registry.execute(id, "code.result", { executionId: direct.record.id })).record.status).toBe("failed");
    const other = agentSessionRuntime.create({ projectId, profileId: "synax", prompt: "Other", permissionTier: "unrestricted" }).id;
    expect((await registry.execute(other, "code.result", { executionId })).record.status).toBe("failed");
  });

  it("does not replay a write when retrieving a large return", async () => {
    project();
    const execution = await registry.execute(id, "agent.execute", { code: 'await tools.call("file.write",{path:"once.txt",content:"first"}); return "x".repeat(40000);' });
    expect(execution.record.status).toBe("completed");
    fs.writeFileSync(path.join(dir, "once.txt"), "second");
    expect((await registry.execute(id, "code.result", { executionId: execution.record.id })).record.status).toBe("completed");
    expect(fs.readFileSync(path.join(dir, "once.txt"), "utf8")).toBe("second");
    expect(store.listToolCalls(id).filter(t => t.toolId === "file.write")).toHaveLength(1);
  });

  it("processes dependent reads in a program and exposes only the selected return value to the model", async () => {
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ path: "rows.json", internal: "index-audit-only" }));
    fs.writeFileSync(path.join(dir, "rows.json"), JSON.stringify([
      { id: "a", amount: 3, internal: "row-audit-only" },
      { id: "b", amount: 8, internal: "row-audit-only" },
    ]));
    const projection = project();
    store.appendMessage({ id: "program-request", sessionId: id, runId: null, stepId: null, role: "user", content: "Compute selected total", metadata: { source: "turn_request" }, createdAt: "2026-01-01" });
    store.appendRun({ id: "program-run", sessionId: id, triggerMessageId: "program-request", status: "running", startedAt: "2026-01-01", completedAt: null, currentStep: 0, stopReason: null, model: null, metadata: {} });
    store.appendRunStep({ id: "program-step", sessionId: id, runId: "program-run", index: 0, status: "completed", model: null, startedAt: "2026-01-01", completedAt: "2026-01-01", finishReason: "tool-calls", metadata: {} });
    const executed = await registry.execute(id, "agent.execute", { code: `
      const index = JSON.parse((await tools.call("file.read", {path:"index.json"})).content);
      const rows = JSON.parse((await tools.call("file.read", {path:index.path})).content);
      console.log(index, rows);
      return {total: rows.filter(row => row.amount > 5).reduce((sum, row) => sum + row.amount, 0)};
    ` }, { runId: "program-run", stepId: "program-step", modelToolCallId: "program-call" });
    const result = executed.toolResult?.result;
    expect(result).toMatchObject({ status: "completed", value: { total: 8 } });
    const audit = store.listToolCalls(id);
    expect(audit.filter(record => codeParentId(record))).toHaveLength(2);
    expect(JSON.stringify(audit)).toContain("row-audit-only");
    expect(JSON.stringify(audit)).toContain("index-audit-only");
    expect(createLoopHistoryReader(store, id).listToolCalls().map(record => record.toolId)).toEqual(["agent.execute"]);
    store.appendRunPart({ id: "program-part", sessionId: id, runId: "program-run", stepId: "program-step", kind: "tool_call", sequence: 0, content: "execute program", toolCallId: executed.record.id, metadata: {}, createdAt: "2026-01-01" });
    store.updateRunStep("program-step", { metadata: { contextProjectionVersion: 2, toolContextReceipts: { [executed.record.id]: { version: 1, outputType: "text", text: "index-audit-only row-audit-only" } } } });
    const messages = JSON.stringify(buildLoopModelMessages(store, id, buildLoopToolSet(projection.tools)));
    expect(messages).toContain('"total":8');
    expect(messages).not.toContain("row-audit-only");
    expect(messages).not.toContain("index-audit-only");
    expect(messages).not.toContain("nestedCalls");
  });

  it("loads exact IDs even when query, group and cursor are stale", async () => {
    const result = (await registry.execute(id, "agent.discover", {
      ids: [tool(0).id], query: "unrelated", group: "read", cursor: 100,
    })).toolResult?.result as { contracts: Array<{ id: string }>; missing: string[] };
    expect(result.contracts.map((item) => item.id)).toEqual([tool(0).id]);
    expect(result.missing).toEqual([]);
    expect(project().tools.map((item) => item.id)).toContain(tool(0).id);
  });

  it("browses summaries without mounting tools and reports loaded state", async () => {
    const browse = async () => (await registry.execute(id, "agent.discover", {
      mode: "list", group: "mcp.fixture", ids: [],
    })).toolResult?.result as { results: Array<{ id: string; loaded: boolean }>; contracts: unknown[] };
    expect(await browse()).toMatchObject({ results: [{ id: tool(0).id, loaded: false }], contracts: [] });
    expect(project().tools.map((item) => item.id)).not.toContain(tool(0).id);
    await discover([tool(0).id]);
    expect(await browse()).toMatchObject({ results: [{ id: tool(0).id, loaded: true }] });
  });

  it("finds out-of-order keywords and returns useful groups for empty results", async () => {
    const result = (await registry.execute(id, "agent.discover", { query: "records fixture", group: "mcp" })).toolResult?.result as { contracts: Array<{ id: string }> };
    expect(result.contracts.map((item) => item.id)).toContain(tool(0).id);
    const missing = (await registry.execute(id, "agent.discover", { query: "zzzzunknown" })).toolResult?.result as { groups: Array<{ group: string }>; nextAction: string };
    expect(missing.groups).toEqual(expect.arrayContaining([expect.objectContaining({ group: "mcp.fixture" })]));
    expect(missing.nextAction).toContain("No callable match");
  });

  it("advertises MCP purposes and uses full dotted server IDs", async () => {
    const dotted = { ...tool(1), id: "mcp.docs.internal.read", discoveryGroup: "mcp.docs.internal", label: "Search product manuals" };
    registry.register(dotted);
    expect(project().prompt).toContain("Search product manuals");
    const result = (await registry.execute(id, "agent.discover", { group: "mcp.docs.internal" })).toolResult?.result as { contracts: Array<{ id: string; group: string }> };
    expect(result.contracts).toEqual([expect.objectContaining({ id: dotted.id, group: "mcp.docs.internal" })]);
  });

  it("initializes only new projects and preserves existing composition policy", () => {
    const fresh = initializeProjectSettings("native-new-project");
    expect(fresh.schemaVersion).toBe(3);
    expect(fresh.codeMode).toEqual({ mcpTools: [] });
    updateProjectSettings("native-existing-project", { codeMode: { enabled: false, mcpTools: ["mcp.docs.read"] } }, "test");
    expect(initializeProjectSettings("native-existing-project").codeMode).toEqual({ mcpTools: ["mcp.docs.read"] });
    expect(getProjectSettings("native-old-unconfigured").codeMode?.enabled).toBeUndefined();
    vi.stubEnv("SYNAX_NATIVE_CAPABILITIES", "0");
    expect(initializeProjectSettings("native-legacy-new-project").codeMode?.enabled).toBeUndefined();
  });
  it("keeps common reads and native execution available without discovery", async () => {
    const ids = project().tools.map((item) => item.id);
    expect(ids).toContain("file.read");
    expect(ids).toContain("agent.discover");
    expect(ids).toContain("agent.execute");
    expect(ids).not.toContain("code.run");
    expect(ids).not.toContain("code.tools");
    expect(ids).toContain("file.write");
    const result = await run('const result = await tools.call("file.read", {path:"a.txt"}); return { read: Boolean(result) };');
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ read: true });
  });

  it("composes file writes through the existing registry and mutation tracker", async () => {
    const result = await run('return await tools.call("file.write", {path:"generated.txt", content:"generated by the loop"});');
    expect(result.status).toBe("completed");
    expect(fs.readFileSync(path.join(dir, "generated.txt"), "utf8")).toBe("generated by the loop");
  });

  it("discovers contracts but does not execute them until the next projection", async () => {
    project();
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {path:"a"})`)).status).toBe("failed");
    expect((await discover([tool(0).id])).contracts[0].compose).toBe(true);
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {path:"a"})`)).status).toBe("failed");
    expect(project().tools.map((item) => item.id)).toContain(tool(0).id);
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {path:"a"})`)).status).toBe("completed");
  });

  it("reuses an idempotent disclosure without rewriting session metadata", async () => {
    await discover([tool(0).id]);
    const first = project();
    const before = JSON.stringify(store.getSession(id).sessionMetadata);
    await discover([tool(0).id]);
    const after = JSON.stringify(store.getSession(id).sessionMetadata);
    const second = project();

    expect(after).toBe(before);
    expect(second.tools.map((item) => item.id)).toEqual(first.tools.map((item) => item.id));
    expect(second.prompt).toBe(first.prompt);
  });

  it("rehydrates contracts after restart and summary-only history", async () => {
    await discover([tool(0).id]);
    registry = new ToolRegistry();
    registry.register(tool(0));
    expect(project().tools.map((item) => item.id)).toContain(tool(0).id);
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {path:"a"})`)).status).toBe("completed");
  });

  it("refreshes changed schemas on the next projection and checks grants again at execution", async () => {
    await discover([tool(0).id]);
    project();
    registry.register({ ...tool(0), inputSchema: z.object({ changed: z.boolean() }) });
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {changed:true})`)).status).toBe("failed");
    const refreshed = project().tools.find((item) => item.id === tool(0).id);
    expect(refreshed).toBeDefined();
    expect(z.toJSONSchema(refreshed!.inputSchema!)).toMatchObject({ properties: { changed: { type: "boolean" } } });
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {changed:true})`)).status).toBe("completed");
    updateProjectSettings(projectId, { codeMode: { mcpTools: [] } }, "test");
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {changed:true})`)).status).toBe("denied");
  });

  it("keeps native execution available with deprecated composition flags", async () => {
    updateProjectSettings(projectId, { codeMode: { enabled: false } }, "test");
    const projected = project();
    expect(projected.tools.map((item) => item.id)).toContain("agent.discover");
    expect(projected.tools.map((item) => item.id)).toContain("agent.execute");
    expect(projected.prompt).toContain("Use agent.execute");
    await discover(["file.write"]);
    expect(project().tools.map((item) => item.id)).toContain("file.write");
    expect((await discover(["file.write"])).contracts[0].compose).toBe(true);
    vi.stubEnv("SYNAX_NATIVE_CAPABILITIES", "0");
    expect(project().prompt).toContain("Use agent.execute");
    expect(project().tools.map((item) => item.id)).toContain("file.write");
  });

  it("ignores deprecated environment flags and excludes external backends", () => {
    vi.stubEnv("SYNAX_CODE_MODE", "0");
    expect(project().tools.map((item) => item.id)).toContain("agent.execute");
    store.updateSessionMetadata(id, { backend: { id: "acp" } });
    expect(project().tools.map((item) => item.id)).not.toContain("agent.discover");
    expect(project().tools.map((item) => item.id)).not.toContain("agent.execute");
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

  it("retains every discovered tool beyond the former count and token budgets", () => {
    const all = new Map(Array.from({ length: 30 }, (_, index) => {
      const contract = capabilityContract(tool(index), true);
      return [contract.id, { ...contract, tokens: 9000 }] as const;
    }));
    let state = readDisclosure(null, id);
    for (const contract of all.values()) state = disclose(state, [contract], all);
    state = readDisclosure(JSON.parse(JSON.stringify(state)), id);
    expect(new Set(state.entries.map((entry) => entry.id))).toEqual(new Set(all.keys()));
    expect(reconcileDisclosure(state, all)).toEqual(state);
  });

  it("keeps all discovered tools in later model requests after rebuilding the registry", async () => {
    for (let index = 1; index < 20; index++) registry.register(tool(index));
    for (let index = 0; index < 20; index += 4) {
      await discover(Array.from({ length: 4 }, (_, offset) => tool(index + offset).id));
      project();
    }
    registry = new ToolRegistry();
    for (let index = 0; index < 20; index++) registry.register(tool(index));
    const projected = project();
    const ids = projected.tools.map((item) => item.id);
    for (let index = 0; index < 20; index++) expect(ids).toContain(tool(index).id);
    expect(project().tools.map((item) => item.id)).toEqual(ids);
    expect(projected.prompt).toContain("stay loaded across turns and context compaction");
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {path:"a"})`)).status).toBe("completed");
  });

  it("discovers oversized contracts and exposes every result in a page", async () => {
    const large = { ...tool(1), description: "Detailed capability contract. ".repeat(10000) };
    expect(capabilityContract(large, false).tokens).toBeGreaterThan(8000);
    registry.register(large);
    const ids = [tool(0).id, large.id];
    expect((await discover(ids)).contracts.map((item) => item.id)).toEqual(ids);
    expect(project().tools.map((item) => item.id)).toEqual(expect.arrayContaining(ids));
  });

  it("removes unavailable tools from persisted disclosure and rejects stale execution", async () => {
    await discover([tool(0).id]);
    project();
    registry = new ToolRegistry();
    expect(project().tools.map((item) => item.id)).not.toContain(tool(0).id);
    expect(readDisclosure(store.getSession(id).sessionMetadata?.capabilityDisclosure, id).entries).toEqual([]);
    expect((await run(`return await tools.call(${JSON.stringify(tool(0).id)}, {path:"a"})`)).status).toBe("denied");
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
