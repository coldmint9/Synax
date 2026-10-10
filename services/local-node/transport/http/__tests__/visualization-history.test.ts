import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentRuntimeRoutes } from "../agent-runtime.js";
import { agentSessionRuntime } from "../../../modules/agent-runtime/session-runtime.js";
import { agentRuntimeStore as store } from "../../../modules/agent-runtime/session-store.js";
import { persistInlineVisualization } from "../../../modules/agent-runtime/visualization-integration.js";
import { readHistoryWindow } from "../../../modules/agent-runtime/checkpoints/version-runtime/window.js";
import { plannerSessionInput, resetAgentRuntimeFixtures } from "../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js";

beforeEach(() => {
  vi.stubEnv("SYNAX_VERSION_HISTORY", "boundary");
  resetAgentRuntimeFixtures();
});
afterEach(() => vi.unstubAllEnvs());

it("loads a large persisted preview omitted from a bounded history window", async () => {
  const session = agentSessionRuntime.create({ ...plannerSessionInput, workDir: process.cwd() });
  const html = `<button>Saved preview</button><!--${"x".repeat(40_000)}-->`;
  const message = store.appendMessage({
    id: "large-preview", sessionId: session.id, runId: null, stepId: null,
    role: "assistant", content: `Before\n\`\`\`synax-visualize\n${html}\n\`\`\`\nAfter`,
    metadata: {}, createdAt: new Date().toISOString(),
  });
  persistInlineVisualization(message);
  expect(message.metadata.source).toBe("inline_visualization");
  const history = readHistoryWindow(session.id);
  expect(history.messages.find((row) => row.id === message.id)?.historyProjection)
    .toMatchObject({ omittedFields: expect.arrayContaining(["metadata"]) });
  const response = await agentRuntimeRoutes.request(
    `http://localhost/sessions/${session.id}/messages/${message.id}/visualization`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ message: {
    content: message.content, metadata: { visualization: { html } },
  } });
  // Reloading repeatedly reads the same stored snapshot.
  expect(store.getMessage(session.id, message.id)?.metadata).toEqual(message.metadata);
  const other = agentSessionRuntime.create({ ...plannerSessionInput, workDir: process.cwd() });
  expect((await agentRuntimeRoutes.request(
    `http://localhost/sessions/${other.id}/messages/${message.id}/visualization`,
  )).status).toBe(404);
});

it("does not promote a partial reply into an executable preview", async () => {
  const session = agentSessionRuntime.create({ ...plannerSessionInput, workDir: process.cwd() });
  store.appendMessage({ id: "partial", sessionId: session.id, runId: null, stepId: null,
    role: "assistant", content: "```synax-visualize\n<button>Draft</button>\n```",
    metadata: { partial: true }, createdAt: new Date().toISOString() });
  const response = await agentRuntimeRoutes.request(
    `http://localhost/sessions/${session.id}/messages/partial/visualization`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ message: null });
});

it("restores all previews in a goal result without changing placeholder offsets", async () => {
  const session = agentSessionRuntime.create({ ...plannerSessionInput, workDir: process.cwd() });
  const content = "Before[交互预览]Between[交互预览]After";
  const visualizations = ["first", "second"].map((id, index) => {
    const start = index === 0 ? content.indexOf("[交互预览]") : content.lastIndexOf("[交互预览]");
    return { id, html: `<p>${id}</p><!--${"x".repeat(30_000)}-->`, start, end: start + "[交互预览]".length };
  });
  store.appendMessage({ id: "goal", sessionId: session.id, runId: null, stepId: null,
    role: "assistant", content, metadata: { purpose: "work_result", visualizations },
    createdAt: new Date().toISOString() });
  expect(readHistoryWindow(session.id).messages[0].historyProjection)
    .toMatchObject({ omittedFields: ["metadata"] });
  const response = await agentRuntimeRoutes.request(
    `http://localhost/sessions/${session.id}/messages/goal/visualization`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ message: {
    content, metadata: { purpose: "work_result", visualizations },
  } });
});
