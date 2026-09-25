import { expect, it } from "vitest";
import { buildConversationTimeline } from "../buildConversationTimeline";
import { buildInterleavedTurns } from "../buildInterleavedTurns";
import {
  hideVisualizationSource,
  visualizationReplyParts,
} from "../visualizationTranscript";
import type {
  AgentRuntimeMessage,
  AgentRunStep,
  AgentSession,
} from "../../../../lib/api/agentRuntime";
const fence = "```synax-visualize\n<button>Demo</button>\n```";
const content = `Before\n${fence}\nAfter`;
const visualization = {
  id: "m:abc",
  html: "<button>Demo</button>",
  start: 7,
  end: 7 + fence.length,
};
const message: AgentRuntimeMessage = {
  id: "m",
  sessionId: "s",
  runId: "r",
  stepId: "step",
  role: "assistant",
  content,
  metadata: { source: "inline_visualization", visualization },
  createdAt: "2026-09-22T12:00:00Z",
};
const step: AgentRunStep = {
  id: "step",
  runId: "r",
  sessionId: "s",
  index: 1,
  status: "completed",
  model: null,
  startedAt: message.createdAt,
  completedAt: message.createdAt,
  finishReason: "end_turn",
  metadata: {},
};

it("keeps text → preview → text together outside a folded work log, without duplicate cards", () => {
  const entries = buildConversationTimeline(
    [],
    [step],
    [message, message],
    [],
    [],
    { foldWorkRuns: true },
  );
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    kind: "agent",
    turn: {
      blocks: [
        { type: "text", content: "Before\n" },
        {
          type: "visualization",
          reference: { id: visualization.id, html: visualization.html },
        },
        { type: "text", content: "\nAfter" },
      ],
    },
  });
  expect(buildInterleavedTurns([step], [], [message])[0].blocks).toHaveLength(
    3,
  );
});
it("keeps preview-only and orphan completion replies visible", () => {
  const only = {
    ...message,
    content: fence,
    metadata: {
      ...message.metadata,
      visualization: { ...visualization, start: 0, end: fence.length },
    },
  };
  for (const steps of [[], [step]]) {
    const entries = buildConversationTimeline([], steps, [only, only], []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "agent",
      turn: { blocks: [{ type: "visualization" }] },
    });
  }
});
it("preserves every visual reply before a goal continuation", () => {
  const next = {
    ...message,
    id: "next",
    stepId: "step2",
    createdAt: "2026-09-22T12:00:01Z",
    metadata: {
      ...message.metadata,
      visualization: { ...visualization, id: "next:hash" },
    },
  };
  const entries = buildConversationTimeline(
    [],
    [step, { ...step, id: "step2", index: 2, startedAt: next.createdAt }],
    [message, next],
    [],
  );
  expect(entries.filter((e) => e.kind === "agent")).toHaveLength(2);
});
it("ignores user/legacy/partial/malformed metadata and scopes the active session", () => {
  const rendered = (m: AgentRuntimeMessage) =>
    visualizationReplyParts(m).filter((p) => p.type === "visualization");
  expect(rendered({ ...message, role: "user" })).toEqual([]);
  expect(
    rendered({
      ...message,
      metadata: {
        source: "interactive_prototype",
        prototypes: [visualization],
      },
    }),
  ).toEqual([]);
  expect(
    rendered({ ...message, metadata: { ...message.metadata, partial: true } }),
  ).toEqual([]);
  expect(
    rendered({
      ...message,
      metadata: {
        source: "inline_visualization",
        visualization: { ...visualization, end: content.length + 1 },
      },
    }),
  ).toEqual([]);
  expect(
    buildConversationTimeline([], [], [message], [], [], {
      session: { id: "other" } as AgentSession,
    }),
  ).toEqual([]);
});
it("hides streaming source but never interprets nested examples or ordinary HTML", () => {
  expect(
    hideVisualizationSource(
      "Before\n```synax-visualize\n<button>unfinished",
      true,
    ),
  ).toBe("Before\n正在生成交互预览…");
  expect(
    hideVisualizationSource("```html\n<button>Sample</button>\n```"),
  ).toContain("<button>");
  const quoted = fence
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  expect(hideVisualizationSource(quoted)).toBe(quoted);
});

it("projects a real visualize file reference in place without showing its control characters", () => {
  const reference =
    'visualize{"path":"/workspace/navbar-demo.html","mode":"wide","title":"导航栏"}';
  const parts = visualizationReplyParts({
    ...message,
    content: `Before\n${reference}\nAfter`,
    metadata: {
      source: "inline_visualization",
      visualization: {
        id: "real-ref",
        html: "<button>Work</button>",
        title: "导航栏",
        mode: "wide",
        start: 7,
        end: 7 + reference.length,
      },
    },
  });
  expect(parts.map((p) => p.type)).toEqual(["text", "visualization", "text"]);
  expect(parts[1]).toMatchObject({
    reference: { title: "导航栏", mode: "wide", html: "<button>Work</button>" },
  });
  expect(hideVisualizationSource(reference, true)).toBe("正在生成交互预览…");
  expect(
    hideVisualizationSource("```text\n" + reference + "\n```", true),
  ).toContain(reference);
});

it("renders multiple persisted visualizations from a goal final summary", () => {
  const marker = "[交互预览]";
  const content = `目标已完成\n\n${marker}\n\n${marker}`;
  const firstStart = content.indexOf(marker);
  const secondStart = content.indexOf(marker, firstStart + marker.length);
  const parts = visualizationReplyParts({
    ...message,
    content,
    metadata: {
      purpose: "work_result",
      visualizations: [
        { id: "final-1", html: "<button>One</button>", start: firstStart, end: firstStart + marker.length },
        { id: "final-2", html: "<button>Two</button>", start: secondStart, end: secondStart + marker.length },
      ],
    },
  });
  expect(parts.filter((part) => part.type === "visualization")).toHaveLength(2);
  expect(parts.map((part) => part.type)).toEqual([
    "text",
    "visualization",
    "visualization",
  ]);
});
