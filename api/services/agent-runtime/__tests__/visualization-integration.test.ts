import { beforeEach, afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resetAgentRuntimeFixtures,
  plannerSessionInput,
} from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { persistInlineVisualization } from "../visualization-integration.js";
import { getRawSqlite } from "../../../db/index.js";
import { agentRuntimeRoutes } from "../../../routes/agent-runtime.js";
import { skillRegistry } from "../../skills/skill-registry.js";
import type { AgentRuntimeMessage } from "../contracts.js";
let sessionId: string, workspace: string;
beforeEach(() => {
  resetAgentRuntimeFixtures();
  workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "visualize-integration-")),
  );
  sessionId = agentSessionRuntime.create({
    ...plannerSessionInput,
    workDir: workspace,
  }).id;
});
afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));
function message(overrides: Partial<AgentRuntimeMessage> = {}) {
  return store.appendMessage({
    id: "reply",
    sessionId,
    role: "assistant",
    runId: null,
    stepId: null,
    content: 'Before\n```synax-visualize\n<div id="demo">Hi</div>\n```\nAfter',
    metadata: { source: "work_result", usage: { outputTokens: 4 } },
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}
it("freezes the fragment in the existing message, preserves ordering/metadata and handles stale callers", () => {
  const m = message(),
    stale = structuredClone(m);
  message({ id: "next", role: "user", content: "Next" });
  const before = store.listMessages(sessionId).map((m) => m.id);
  persistInlineVisualization(m);
  persistInlineVisualization(stale);
  const saved = store.listMessages(sessionId);
  expect(saved.map((m) => m.id)).toEqual(before);
  expect(saved[0].metadata).toMatchObject({
    source: "inline_visualization",
    visualizationOrigin: "work_result",
    usage: { outputTokens: 4 },
    visualization: { html: '<div id="demo">Hi</div>' },
  });
  expect(stale.metadata).toEqual(m.metadata);
  expect(saved[0].content).toBe(m.content);
  // No platform table is written by the new path.
  const tables = getRawSqlite()
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'agent_artifact%' OR name LIKE 'artifact_%')",
    )
    .all() as { name: string }[];
  for (const { name } of tables)
    expect(
      getRawSqlite().prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get(),
    ).toMatchObject({ count: 0 });
});
it.each([
  { role: "user" },
  { metadata: { partial: true } },
  { metadata: { type: "thinking" } },
])("never renders untrusted or incomplete messages: %s", (override) => {
  const m = message(override as Partial<AgentRuntimeMessage>);
  persistInlineVisualization(m);
  expect(m.metadata.visualization).toBeUndefined();
});
it("finishes snapshot persistence even when the originating turn is aborted", () => {
  const m = message();
  persistInlineVisualization(m, AbortSignal.abort());
  expect(m.metadata.visualization).toMatchObject({
    html: '<div id="demo">Hi</div>',
  });
  persistInlineVisualization({ ...m, content: m.content + "stale" });
  expect(
    store.getMessage(sessionId, m.id)?.metadata.visualization,
  ).toMatchObject({ html: '<div id="demo">Hi</div>' });
  getRawSqlite()
    .prepare("DELETE FROM agent_runtime_messages WHERE id = ?")
    .run(m.id);
  persistInlineVisualization(m);
  expect(store.getMessage(sessionId, m.id)).toBeUndefined();
});
it("stores a small error instead of executing invalid markup", () => {
  const m = message({
    content: "Done\n```synax-visualize\n<iframe></iframe>\n```",
  });
  persistInlineVisualization(m);
  expect(m.metadata.visualization).toMatchObject({ error: expect.any(String) });
  expect((m.metadata.visualization as { html?: string }).html).toBeUndefined();
});
it("discovers the new skill and does not mount retired platform APIs", async () => {
  const skills = skillRegistry.listSummaries({
    profileId: "executor",
    projectId: "project-alpha",
  });
  expect(skills.some((s) => s.id === "synax-builtin/visualize")).toBe(true);
  expect(skills.some((s) => s.id.includes("interactive-artifacts"))).toBe(
    false,
  );
  for (const suffix of [
    "/jobs",
    "/revisions/old/bundle",
    "/revisions/old/state",
    "/revisions/old/feedback",
    "/old/versions",
  ])
    expect(
      (
        await agentRuntimeRoutes.request(
          `/sessions/${sessionId}/artifacts${suffix}`,
        )
      ).status,
    ).toBe(404);
  expect(
    (await agentRuntimeRoutes.request(`/sessions/${sessionId}/artifacts`))
      .status,
  ).toBe(200); // Ordinary evidence remains.
});

function reference(file: string) {
  return `visualize${JSON.stringify({ path: file, title: "导航栏 Demo", mode: "wide" })}`;
}
it("resolves the actual skill file reference once, without a build, and preserves title/wide mode", () => {
  const file = path.join(workspace, "navbar-demo.html");
  fs.writeFileSync(file, '<button id="navbar">Work</button>');
  const m = message({ content: `Before\n\n${reference(file)}\n\nAfter` });
  persistInlineVisualization(m);
  expect(m.metadata.visualization).toMatchObject({
    html: '<button id="navbar">Work</button>',
    title: "导航栏 Demo",
    mode: "wide",
  });
  fs.unlinkSync(file);
  const stale = { ...m, metadata: {} };
  persistInlineVisualization(stale);
  expect(stale.metadata).toEqual(m.metadata);
});
it("rehydrates the reported completed, step-less work_result via the messages API", async () => {
  const file = path.join(workspace, "navbar-demo.html");
  fs.writeFileSync(file, "<button>Saved navigation</button>");
  const run = store.appendRun({
    id: "completed-visual-run",
    sessionId,
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    triggerMessageId: null,
    currentStep: 1,
    stopReason: "work_completed",
    model: null,
    metadata: {},
  });
  const m = message({
    runId: run.id,
    stepId: null,
    metadata: { purpose: "work_result" },
    content: reference(file),
  });
  const reply = await agentRuntimeRoutes.request(
    `/sessions/${sessionId}/messages`,
  );
  expect(reply.status).toBe(200);
  const data = (await reply.json()) as { items: AgentRuntimeMessage[] };
  expect(data.items[0].metadata.visualization).toMatchObject({
    html: "<button>Saved navigation</button>",
  });
  fs.unlinkSync(file);
  const again = (await (
    await agentRuntimeRoutes.request(`/sessions/${sessionId}/messages`)
  ).json()) as { items: AgentRuntimeMessage[] };
  expect(again.items[0].metadata).toEqual(data.items[0].metadata);
  expect(store.getMessage(sessionId, m.id)?.content).toBe(m.content);
});
it.each(["running", "failed", "cancelled", "interrupted"] as const)(
  "does not rehydrate a %s run even if it contains a complete reference",
  async (status) => {
    const file = path.join(workspace, "never.html");
    fs.writeFileSync(file, "<button>Do not run</button>");
    store.appendRun({
      id: "unsafe-run",
      sessionId,
      status,
      startedAt: "",
      completedAt: null,
      triggerMessageId: null,
      currentStep: 1,
      stopReason: null,
      model: null,
      metadata: {},
    });
    const m = message({ runId: "unsafe-run", content: reference(file) });
    await agentRuntimeRoutes.request(`/sessions/${sessionId}/messages`);
    expect(
      store.getMessage(sessionId, m.id)?.metadata.visualization,
    ).toBeUndefined();
  },
);
it("returns a light diagnostic rather than a raw reference for missing or unauthorized HTML", () => {
  for (const file of [
    path.join(workspace, "missing.html"),
    path.join(os.tmpdir(), "outside.html"),
  ]) {
    const m = message({ content: reference(file) });
    persistInlineVisualization(m);
    expect(m.metadata.visualization).toMatchObject({
      error: expect.any(String),
    });
    expect(JSON.stringify(m.metadata.visualization)).not.toContain(workspace);
  }
});
