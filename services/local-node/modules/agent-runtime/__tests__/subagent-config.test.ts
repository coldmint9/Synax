import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { toolRegistry } from "../tool-registry.js";
import { createConfiguredSubagent } from "../subagent-delegation.js";
import { subagentTemplates } from "../subagent-templates.js";
import { prepareTurnReferences } from "../turn-references.js";
import { applySessionPermissionUpdate } from "../session-permissions.js";
import { businessStore } from "../../../infrastructure/persistence/business-store.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { resetAgentRuntimeFixtures, admitActiveFixtureRun } from "./agent-runtime-fixtures.js";
import type { ToolExecutionInput } from "../contracts.js";
import { inputQueueRuntime } from "../input-queue-runtime.js";

let root: string;
let parentId: string;
const input = () => ({ sessionId: parentId, toolId: "subagent.delegate", args: {}, category: "task", mutability: "task" }) as ToolExecutionInput;
const template = { name: "审查助手", description: "检查实现风险", instructions: "保留现有实现，报告具体风险。", access: "read-only" as const };
beforeEach(async () => {
  await resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synax-generic-")));
  parentId = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Implement", workDir: root,
    permissionTier: "unrestricted", sessionMetadata: { mode: "chat" } }).id;
});
afterEach(async () => { await store.flush(); await businessStore.flush(); fs.rmSync(root, { recursive: true, force: true }); });

describe("generic subagent configuration", () => {
  it("enforces the child limit even when the parent delegates concurrently", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      createConfiguredSubagent(input(), { prompt: `Inspect area ${index}`, profile: { access: "read-only" } })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(store.getSession(parentId).childSessionIds).toHaveLength(5);
  });
  it("automatically inherits parent tools and authorization and supports shell execution", async () => {
    const { child } = await createConfiguredSubagent(input(), { prompt: "Check the workspace" });
    expect(child.profileId).toBe("subagent");
    const tools = toolRegistry.listForSession(child.id).map(tool => tool.id);
    expect(tools).toContain("bash"); expect(tools).toContain("file.write");
    expect(tools).not.toContain("subagent.delegate"); expect(tools).not.toContain("human.ask");
    const call = await toolRegistry.execute(child.id, "bash", { command: "printf inherited" });
    expect(call.record).toMatchObject({ status: "completed", outputRef: { stdout: "inherited" } });
    expect(store.listPermissions(child.id).some(item => item.action === "ask")).toBe(false);
  });
  it("keeps scoped writers within their files and prevents shell bypasses", async () => {
    const { child } = await createConfiguredSubagent(input(), { prompt: "Implement", profile: { writeScope: ["src"] } });
    expect(toolRegistry.listForSession(child.id).some(tool => tool.id === "bash")).toBe(false);
    expect((await toolRegistry.execute(child.id, "file.write", { path: "src/a.txt", content: "ok" })).record.status).toBe("completed");
    expect((await toolRegistry.execute(child.id, "file.write", { path: "other.txt", content: "bad" })).record.error).toContain("writeScope");
    expect(fs.existsSync(path.join(root, "other.txt"))).toBe(false);
  });
  it("inherits a parent permission revocation without retaining an old allow", async () => {
    const { child } = await createConfiguredSubagent(input(), { prompt: "Implement" });
    applySessionPermissionUpdate(parentId, { permissionOverrides: { write: "deny" } });
    const call = await toolRegistry.execute(child.id, "file.write", { path: "no.txt", content: "bad" });
    expect(["failed", "denied"]).toContain(call.record.status);
    expect(fs.existsSync(path.join(root, "no.txt"))).toBe(false);
  });
  it("preserves saved instructions and restrictive access when the parent configures a template", async () => {
    const saved = subagentTemplates.save(template);
    const { child } = await createConfiguredSubagent(input(), { prompt: "Inspect", templateId: saved.id, profile: { instructions: "Focus on concurrency." } });
    const config = child.sessionMetadata?.subagentProfile as { profile: { instructions: string } };
    expect(config.profile.instructions).toContain(template.instructions);
    expect(config.profile.instructions).toContain("Focus on concurrency.");
    expect(toolRegistry.listForSession(child.id).map(tool => tool.id)).not.toContain("file.write");
    await expect(createConfiguredSubagent(input(), { prompt: "Inspect", templateId: saved.id, profile: { access: "inherit" } })).rejects.toThrow(/cannot be expanded/);
  });
  it("uses an immutable selected template through queued input and defaults delegation to it", async () => {
    const saved = subagentTemplates.save(template); await businessStore.flush();
    const run = await admitActiveFixtureRun(parentId);
    const [queued] = await inputQueueRuntime.enqueue(parentId, { message: "Review", references: [{ kind: "subagent", id: saved.id }] });
    subagentTemplates.save({ ...template, instructions: "Changed later" }, saved.id); await businessStore.flush();
    const context = prepareTurnReferences(parentId, queued.references, undefined, queued.referenceContext?.subagentProfiles)!;
    store.updateRun(run.id, { metadata: { ...store.getRun(run.id).metadata, turnReferences: context } });
    const { child } = await createConfiguredSubagent(input(), { prompt: "Review" });
    expect(child.sessionMetadata?.subagentProfile).toMatchObject({ templateId: saved.id, profile: { instructions: template.instructions } });
    expect(context.content).toContain(saved.id);
    expect((await inputQueueRuntime.list(parentId))[0].referenceContext?.subagentProfiles?.[0].instructions).toBe(template.instructions);
  });
  it("rejects unavailable or recursive capabilities and ignores no saved restrictions", async () => {
    await expect(createConfiguredSubagent(input(), { prompt: "Task", profile: { capabilities: ["subagent.delegate"] } })).rejects.toThrow(/unavailable/);
    const saved = subagentTemplates.save({ ...template, enabled: false });
    expect(() => prepareTurnReferences(parentId, [{ kind: "subagent", id: saved.id }])).toThrow(/disabled/);
    await expect(createConfiguredSubagent(input(), { prompt: "Task", templateId: saved.id })).rejects.toThrow(/disabled/);
  });
});
