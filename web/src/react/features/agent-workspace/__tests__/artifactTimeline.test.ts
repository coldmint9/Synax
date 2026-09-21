import { describe, it, expect } from "vitest";
import { buildConversationTimeline } from "../buildConversationTimeline";
import { buildTurnRenderSegments } from "../toolCallUtils";
import type { AgentRuntimeMessage } from "../../../../lib/api/agentRuntime";
const ref = {
  type: "artifact" as const,
  artifactId: "art_demo",
  revisionId: "arv_demo",
  title: "Demo",
  presentation: "inline" as const,
};
const message = {
  id: "msg_art",
  sessionId: "s",
  runId: null,
  stepId: null,
  role: "assistant",
  content: "Demo",
  createdAt: "2026-09-21T00:00:00Z",
  metadata: { source: "artifact_publisher", artifacts: [ref] },
} as AgentRuntimeMessage;
describe("interactive artifact timeline", () => {
  it("renders committed artifacts without a run and keeps the fixed revision", () => {
    const timeline = buildConversationTimeline([], [], [message], []);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      kind: "agent",
      turn: { blocks: [{ type: "artifact", reference: ref }] },
    });
  });
  it("deduplicates repeated snapshot metadata and ignores untrusted user metadata", () => {
    expect(
      buildConversationTimeline([], [], [message, message], []),
    ).toHaveLength(1);
    expect(
      buildConversationTimeline(
        [],
        [],
        [{ ...message, role: "user" }],
        [],
      ).some((e) => e.kind === "agent"),
    ).toBe(false);
  });
  it("preserves artifact blocks when projecting render segments", () =>
    expect(
      buildTurnRenderSegments([{ type: "artifact", reference: ref }]),
    ).toEqual([{ type: "artifact", reference: ref }]));
});
