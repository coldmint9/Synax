import { beforeEach, expect, it, vi } from "vitest";
import { resetAgentRuntimeFixtures, admitActiveFixtureRun } from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { runtimeClient } from "../sidecar/runtime-repository.js";

beforeEach(async () => { await resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered(); });
it("keeps the admitted run readable and preserves updates while history refresh waits", async () => {
  const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "fixture" });
  const run = await admitActiveFixtureRun(session.id);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = runtimeClient();
  const original = client.historyCommand.bind(client);
  const read = vi.spyOn(client, "historyCommand").mockImplementation(async input => {
    const value = await original(input);
    if (input.sessionId === session.id && input.operation === "list_runs") { entered(); await gate; }
    return value;
  });
  const refresh = store.hydrateSession(session.id, true);
  try {
    await blocked;
    expect(store.getRun(run.id).id).toBe(run.id);
    store.updateRun(run.id, { currentStep: 7, metadata: { newLeaseMarker: "must-survive" } });
    store.appendMessage({ id: "during-refresh", sessionId: session.id, runId: run.id, stepId: null,
      role: "assistant", content: "new output", metadata: {}, createdAt: new Date().toISOString() });
    release();
    await refresh;
    expect(store.getRun(run.id)).toMatchObject({ currentStep: 7, metadata: { newLeaseMarker: "must-survive" } });
    expect(store.getMessage(session.id, "during-refresh")?.content).toBe("new output");
    await store.flushSession(session.id);
    await store.hydrateSession(session.id, true);
    expect(store.getRun(run.id).currentStep).toBe(7);
  } finally { release(); await refresh; read.mockRestore(); }
});

it("leaves the previous working set intact when one history read fails", async () => {
  const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "fixture" });
  const run = await admitActiveFixtureRun(session.id);
  const client = runtimeClient();
  const original = client.historyCommand.bind(client);
  const read = vi.spyOn(client, "historyCommand").mockImplementation(async input => {
    if (input.operation === "list_runs") throw new Error("history temporarily unavailable");
    return original(input);
  });
  try {
    await expect(store.hydrateSession(session.id, true)).rejects.toThrow("history temporarily unavailable");
    expect(store.getRun(run.id).id).toBe(run.id);
    expect(store.getSession(session.id).activeRunId).toBe(run.id);
  } finally { read.mockRestore(); }
});
