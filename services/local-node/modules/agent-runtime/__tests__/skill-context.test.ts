import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { skillAgentBridge } from "../../skills/agent-bridge.js";
import { skillRegistry } from "../../skills/skill-registry.js";
import type { SkillDetail } from "../../skills/types.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { loadedSkillContext, rememberLoadedSkill } from "../skill-context.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { pendingTurnReferenceSkillLoads } from "../turn-reference-state.js";

beforeEach(async () => { await resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered(); });
afterEach(() => vi.restoreAllMocks());

const skill: SkillDetail = { id: "fixture/skill", name: "fixture", label: "Fixture", description: "Fixture skill",
  sourceId: "fixture", sourceKind: "builtin", version: "1", appliesTo: ["executor"],
  requiredCapabilities: [], permissionHints: [], status: "available", injection: "on-demand",
  contentDigest: "", content: "Keep this exact instruction." };

function allowRetention() {
  return vi.spyOn(skillAgentBridge, "canRetainForContext").mockReturnValue(true);
}

describe("loaded skill context", () => {
  it("retains a successful load for the active run and emits a digest", () => {
    const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Use the skill", sessionMetadata: { mode: "chat" } });
    const retention = allowRetention();
    store.updateSession(session.id, { activeRunId: "run-1" });
    store.appendRun({ id: "run-1", sessionId: session.id, status: "running", startedAt: new Date().toISOString(), completedAt: null, triggerMessageId: null, currentStep: 1, stopReason: null, model: null, metadata: {} });
    rememberLoadedSkill(session.id, "run-1", skill);
    const prompt = loadedSkillContext(session.id, []);
    expect(prompt).toContain("Keep this exact instruction.");
    expect(prompt).toContain("sha256=");
    retention.mockRestore();
  });

  it("keeps a loaded skill for an active goal work item across a new run", () => {
    const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Use the skill", sessionMetadata: { mode: "goal", activeWorkId: "work-1" } });
    const retention = allowRetention();
    store.updateSession(session.id, { activeRunId: "run-1" });
    store.appendRun({ id: "run-1", sessionId: session.id, status: "running", startedAt: new Date().toISOString(), completedAt: null, triggerMessageId: null, currentStep: 1, stopReason: null, model: null, metadata: {} });
    rememberLoadedSkill(session.id, "run-1", skill);
    store.updateSession(session.id, { activeRunId: "run-2" });
    store.appendRun({ id: "run-2", sessionId: session.id, status: "running", startedAt: new Date(Date.now() + 1).toISOString(), completedAt: null, triggerMessageId: null, currentStep: 1, stopReason: null, model: null, metadata: {} });
    expect(loadedSkillContext(session.id, [])).toContain("Keep this exact instruction.");
    retention.mockRestore();
  });

  it("does not retain an unrelated skill after the task changes", () => {
    const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Use the skill", sessionMetadata: { mode: "chat" } });
    const retention = allowRetention();
    store.updateSession(session.id, { activeRunId: "run-1" });
    store.appendRun({ id: "run-1", sessionId: session.id, status: "running", startedAt: new Date().toISOString(), completedAt: null, triggerMessageId: null, currentStep: 1, stopReason: null, model: null, metadata: {} });
    rememberLoadedSkill(session.id, "old-run", skill);
    expect(loadedSkillContext(session.id, [])).toBeNull();
    retention.mockRestore();
  });

  it("stops exposing retained instructions after permission is revoked", () => {
    const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Use the skill" });
    const retention = allowRetention();
    rememberLoadedSkill(session.id, null, skill);
    expect(loadedSkillContext(session.id, [skill.id])).toContain(skill.content);
    retention.mockReturnValue(false);
    expect(loadedSkillContext(session.id, [skill.id])).toBeNull();
  });

  it("restores the exact loaded body after host state is rehydrated", async () => {
    const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Use the skill" });
    allowRetention();
    rememberLoadedSkill(session.id, null, skill);
    await store.flushSession(session.id);
    store.reset();
    await store.hydrateExecutionSession(session.id, true);
    expect(loadedSkillContext(session.id, [skill.id])).toContain(skill.content);
    expect(store.getSession(session.id).sessionMetadata?.loadedSkillContexts).toHaveProperty(skill.id);
  });

  it("keeps the same task's instructions through repeated bare continuations", () => {
    const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Use the skill" });
    allowRetention();
    const append = (id: string, index: number, content: string) => {
      store.appendMessage({ id: `input-${id}`, sessionId: session.id, runId: id, stepId: null,
        role: "user", content, metadata: {}, createdAt: new Date(index).toISOString() });
      store.appendRun({ id, sessionId: session.id, status: "running", startedAt: new Date(index).toISOString(), completedAt: null,
        triggerMessageId: `input-${id}`, currentStep: 1, stopReason: null, model: null, metadata: {} });
      store.updateSession(session.id, { activeRunId: id });
    };
    append("first", 1, "Use the skill");
    rememberLoadedSkill(session.id, "first", skill);
    append("second", 2, "继续");
    expect(loadedSkillContext(session.id, [])).toContain(skill.content);
    append("third", 3, "continue");
    expect(loadedSkillContext(session.id, [])).toContain(skill.content);
    append("fourth", 4, "A different task");
    expect(loadedSkillContext(session.id, [])).toBeNull();
  });
});

describe("selected skill preparation", () => {
  function mockSkillLookup() {
    vi.spyOn(skillRegistry, "getSummary").mockReturnValue(skill);
    return vi.spyOn(skillRegistry, "loadDetail").mockReturnValue(skill);
  }

  function createSession() {
    return agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Use the skill",
      skillIds: [skill.id], permissionTier: "unrestricted", sessionMetadata: { mode: "chat" } });
  }

  function startRun(sessionId: string, index: number, content = "Use the selected skill") {
    const id = `${sessionId}-run-${index}`;
    store.appendMessage({ id: `input-${id}`, sessionId, runId: id, stepId: null,
      role: "user", content, metadata: {}, createdAt: new Date(index).toISOString() });
    const run = store.appendRun({ id, sessionId, status: "running", startedAt: new Date(index).toISOString(),
      completedAt: null, triggerMessageId: `input-${id}`, currentStep: 1, stopReason: null, model: null, metadata: {} });
    store.updateSession(sessionId, { activeRunId: id });
    return run;
  }

  it("reuses successful loads across runs and forced queue inputs", () => {
    const session = createSession();
    mockSkillLookup();
    const first = startRun(session.id, 1);
    expect(pendingTurnReferenceSkillLoads(session.id)).toHaveLength(1);
    rememberLoadedSkill(session.id, first.id, skill);
    expect(pendingTurnReferenceSkillLoads(session.id)).toEqual([]);

    const second = startRun(session.id, 2);
    expect(pendingTurnReferenceSkillLoads(session.id)).toEqual([]);
    store.updateRun(second.id, { metadata: { turnReferenceInputId: "queued-input" } });
    expect(pendingTurnReferenceSkillLoads(session.id)).toEqual([]);
    expect(loadedSkillContext(session.id, [skill.id])).toContain(skill.content);
  });

  it("reuses persisted instructions even when no historical tool calls remain in host memory", async () => {
    const session = createSession();
    mockSkillLookup();
    rememberLoadedSkill(session.id, startRun(session.id, 1).id, skill);
    await store.flushSession(session.id);
    store.reset();
    await store.hydrateExecutionSession(session.id, true);
    startRun(session.id, 2);
    expect(store.listToolCalls(session.id)).toEqual([]);
    expect(pendingTurnReferenceSkillLoads(session.id)).toEqual([]);
    expect(loadedSkillContext(session.id, [skill.id])).toContain(skill.content);
  });

  it("reloads changed skill content instead of retaining stale instructions", () => {
    const session = createSession();
    const lookup = mockSkillLookup();
    rememberLoadedSkill(session.id, startRun(session.id, 1).id, skill);
    startRun(session.id, 2);
    const updated = { ...skill, content: "Updated instruction." };
    lookup.mockReturnValue(updated);
    expect(pendingTurnReferenceSkillLoads(session.id)).toHaveLength(1);
    expect(loadedSkillContext(session.id, [skill.id])).toBeNull();
    rememberLoadedSkill(session.id, store.getSession(session.id).activeRunId, updated);
    expect(pendingTurnReferenceSkillLoads(session.id)).toEqual([]);
    expect(loadedSkillContext(session.id, [skill.id])).toContain(updated.content);
  });

  it("does not reuse unavailable or no-longer-authorized skills", () => {
    const session = createSession();
    const lookup = mockSkillLookup();
    rememberLoadedSkill(session.id, startRun(session.id, 1).id, skill);
    startRun(session.id, 2);
    lookup.mockImplementation(() => { throw new Error("Skill is unavailable or requires permission"); });
    expect(pendingTurnReferenceSkillLoads(session.id)).toHaveLength(1);
    expect(loadedSkillContext(session.id, [skill.id])).toBeNull();
  });

  it.each(["ask", "deny"] as const)("honors current %s rules without creating approval records", (action) => {
    const session = createSession();
    mockSkillLookup();
    rememberLoadedSkill(session.id, startRun(session.id, 1).id, skill);
    expect(pendingTurnReferenceSkillLoads(session.id)).toEqual([]);
    expect(loadedSkillContext(session.id, [skill.id])).toContain(skill.content);
    expect(store.listPermissions(session.id)).toEqual([]);

    startRun(session.id, 2);
    store.updateSession(session.id, { permissionRules: [
      { gate: "*", pattern: "*", action: "allow" }, { gate: "skill", pattern: skill.id, action },
    ] });
    expect(pendingTurnReferenceSkillLoads(session.id)).toHaveLength(1);
    expect(loadedSkillContext(session.id, [skill.id])).toBeNull();
    expect(store.listPermissions(session.id)).toEqual([]);
  });

  it("does not reuse another session's successful load", () => {
    const first = createSession();
    mockSkillLookup();
    rememberLoadedSkill(first.id, startRun(first.id, 1).id, skill);
    const second = createSession();
    startRun(second.id, 1);
    expect(pendingTurnReferenceSkillLoads(second.id)).toHaveLength(1);
    expect(loadedSkillContext(second.id, [skill.id])).toBeNull();
  });

  it("preserves per-input replay identities but retries an unsuccessful load on a new input", () => {
    const session = createSession();
    const first = startRun(session.id, 1);
    const [call] = pendingTurnReferenceSkillLoads(session.id);
    expect(pendingTurnReferenceSkillLoads(session.id)).toEqual([call]);
    vi.spyOn(store, "listRunToolCalls").mockReturnValue([
      { modelToolCallId: call.id, status: "failed" },
    ] as ReturnType<typeof store.listRunToolCalls>);
    expect(pendingTurnReferenceSkillLoads(session.id)).toEqual([]);
    store.updateRun(first.id, { metadata: { turnReferenceInputId: "retry-input" } });
    expect(pendingTurnReferenceSkillLoads(session.id)).toHaveLength(1);
    expect(pendingTurnReferenceSkillLoads(session.id)[0].id).not.toBe(call.id);
  });

  it("keeps a reused turn-selected skill available for the following bare continuation", () => {
    const session = createSession();
    store.updateSession(session.id, { skillIds: [] });
    mockSkillLookup();
    rememberLoadedSkill(session.id, startRun(session.id, 1).id, skill);
    const second = startRun(session.id, 2, "Explain another part with the selected skill");
    store.updateRun(second.id, { metadata: { turnReferences: { references: [], content: "", skillIds: [skill.id], mcpServerIds: [] } } });
    expect(pendingTurnReferenceSkillLoads(session.id)).toEqual([]);
    expect(loadedSkillContext(session.id, [skill.id])).toContain(skill.content);
    startRun(session.id, 3, "继续");
    expect(loadedSkillContext(session.id, [])).toContain(skill.content);
    startRun(session.id, 4, "An unrelated task");
    expect(loadedSkillContext(session.id, [])).toBeNull();
  });
});
