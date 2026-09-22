import { beforeEach, expect, it } from "vitest";
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
let sessionId: string;
beforeEach(() => {
  resetAgentRuntimeFixtures();
  sessionId = agentSessionRuntime.create(plannerSessionInput).id;
});
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
it("rejects aborts and stale/deleted messages without resurrection", () => {
  const m = message();
  expect(() => persistInlineVisualization(m, AbortSignal.abort())).toThrow();
  persistInlineVisualization({ ...m, content: m.content + "stale" });
  expect(
    store.getMessage(sessionId, m.id)?.metadata.visualization,
  ).toBeUndefined();
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
