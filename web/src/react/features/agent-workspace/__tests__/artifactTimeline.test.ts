import { it, expect } from "vitest";
import { buildConversationTimeline } from "../buildConversationTimeline";
import { messagePrototypes } from "../artifactTranscript";
import type { AgentRuntimeMessage } from "../../../../lib/api/agentRuntime";
const prototype = {
  id: "m:abc",
  title: "Demo",
  html: "<html>Demo</html>",
  sourceKind: "html",
};
const m: AgentRuntimeMessage = {
  id: "m",
  sessionId: "s",
  runId: null,
  stepId: null,
  role: "assistant",
  content: "",
  metadata: { source: "interactive_prototype", prototypes: [prototype] },
  createdAt: "2026-09-22",
};
it("renders immutable message prototypes outside work logs without fetching session artifacts", () => {
  const entries = buildConversationTimeline([], [], [m, m], [], [], {
    foldWorkRuns: true,
  });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    kind: "agent",
    turn: { blocks: [{ type: "prototype", reference: prototype }] },
  });
});
it("limits output to three, ignores user/legacy content, and preserves per-item errors", () => {
  expect(messagePrototypes({ ...m, role: "user" })).toEqual([]);
  expect(
    messagePrototypes({
      ...m,
      metadata: { source: "artifact_publisher", artifacts: [prototype] },
    }),
  ).toEqual([]);
  expect(
    messagePrototypes({
      ...m,
      metadata: { ...m.metadata, prototypes: Array(5).fill(prototype) },
    }),
  ).toHaveLength(3);
  const entries = buildConversationTimeline(
    [],
    [],
    [
      {
        ...m,
        metadata: {
          ...m.metadata,
          prototypeDiagnostics: [
            {
              title: "Failed",
              code: "INVALID_SOURCE",
              message: "Invalid source",
            },
          ],
        },
      },
    ],
    [],
  );
  expect(entries.some((e) => e.kind === "error")).toBe(true);
  expect(entries.some((e) => e.kind === "agent")).toBe(true);
});
