import { describe, expect, it } from "vitest";
import type { AgentRun, AgentRuntimeMessage, AgentRunStep, AgentSession, HistoryWindowResponse } from "../../../adapters/transport/agentRuntime";
import { buildConversationTimeline } from "../buildConversationTimeline";
import { buildInterleavedTurns } from "../buildInterleavedTurns";
import { gitMergeReplyParts, type ConversationGitReference } from "../gitMergeTranscript";
import { buildTurnRenderSegments } from "../toolCallUtils";
import { estimateEntryHeight } from "../TimelineLazyEntry";
import { extendTimelineIndex, previewTimelineMessage, seedTimelineIndex, timelineContainsEntry } from "../state/timelineHistoryIndex";
import type { SessionDetailCacheEntry } from "../state/agentSessionStore";

const reference: ConversationGitReference = {
  schema: "synax.git-merge", schemaVersion: 1, objectId: "task-1", sessionId: "session-1",
  projectId: "project-1", rootId: "root-1", title: "合并会话刷新功能",
};
const message: AgentRuntimeMessage = {
  id: "anchor-1", sessionId: "session-1", runId: "run-1", stepId: "step-1",
  role: "assistant", content: "查看并确认合并方案。",
  metadata: { source: "git_merge_task", gitMergeTask: reference },
  createdAt: "2026-10-22T01:00:01Z",
};
const step: AgentRunStep = {
  id: "step-1", sessionId: message.sessionId, runId: "run-1", index: 1,
  status: "completed", model: null, startedAt: "2026-10-22T01:00:00Z",
  completedAt: "2026-10-22T01:00:02Z", finishReason: "end_turn", metadata: {},
};
const run: AgentRun = {
  id: "run-1", sessionId: message.sessionId, status: "completed", startedAt: step.startedAt,
  completedAt: step.completedAt, triggerMessageId: null, currentStep: 1,
  stopReason: null, model: null, metadata: {},
};
const cards = (entries: ReturnType<typeof buildConversationTimeline>) => entries.flatMap((entry) =>
  entry.kind === "agent" ? entry.turn.blocks.filter((block) => block.type === "git_merge") : [],
);

describe("native Git task transcript", () => {
  it('keeps the expired card in its original position and renders the resumed card at the new time', () => {
    const superseded = { replacementMessageId: 'resumed-anchor', supersededAt: '2026-10-26T09:00:00Z' };
    const old = { ...message, runId: null, stepId: null, metadata: { ...message.metadata, gitMergeTimeline: { state: 'superseded', ...superseded } } };
    const resumed = { ...message, id: superseded.replacementMessageId, runId: null, stepId: null, createdAt: superseded.supersededAt };
    const entries = buildConversationTimeline([], [], [resumed, old], []);
    const rendered = cards(entries);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toMatchObject({ messageId: old.id, superseded });
    expect(rendered[1]).toMatchObject({ messageId: resumed.id });
    expect(rendered[1]).not.toHaveProperty('superseded');
    expect(gitMergeReplyParts(previewTimelineMessage(old))![0].superseded).toEqual(superseded);
    const oldEntry = entries.find(entry => entry.kind === 'agent' && entry.turn.blocks.some(block => block.type === 'git_merge' && block.messageId === old.id))!;
    expect(estimateEntryHeight(oldEntry)).toBeLessThan(150);
  });

  it("renders persisted remote PR references with the same stable transcript contract", () => {
    const remote = { ...reference, schema: "synax.git-pr" as const };
    const messageWithPr = { ...message, metadata: { source: "git_merge_task", gitMergeTask: remote } };
    expect(gitMergeReplyParts(messageWithPr)).toEqual([{ type: "git_merge", reference: remote, messageId: message.id }]);
    expect(previewTimelineMessage(messageWithPr).metadata.gitMergeTask).toEqual(remote);
  });

  it("renders validated metadata as a content segment, independently of tool disclosures", () => {
    const blocks = buildInterleavedTurns([step], [], [message])[0].blocks;
    expect(blocks.map((block) => block.type)).toEqual(["git_merge"]);
    expect(buildTurnRenderSegments(blocks)).toMatchObject([
      { type: "git_merge", reference, messageId: message.id },
    ]);
  });

  it("keeps internal anchor text out of live and historical prose while preserving invalid-metadata fallback", () => {
    const anchor = { ...message, content: "合并任务 objectId=704f1b8e-5f21-460d-978f-b5542b006d86" };
    for (const steps of [[], [step]]) {
      const entries = buildConversationTimeline([run], steps, [anchor], []);
      const blocks = entries.flatMap((entry) => entry.kind === "agent" ? entry.turn.blocks : []);
      expect(blocks).toEqual([{ type: "git_merge", reference, messageId: message.id }]);
      expect(entries.map((entry) => entry.label)).not.toContain(anchor.content);
      expect(entries.find((entry) => entry.kind === "agent")?.label).toBe(reference.title);
      const invalid = { ...anchor, metadata: { ...anchor.metadata, gitMergeTask: { ...reference, schemaVersion: 2 } } };
      const fallback = buildConversationTimeline([run], steps, [invalid], []);
      expect(fallback.flatMap((entry) => entry.kind === "agent" ? entry.turn.blocks : []))
        .toEqual([{ type: "text", content: anchor.content, messageId: message.id }]);
    }
    expect(anchor.content).toContain("objectId=704f1b8e");
  });

  it.each([true, false])("keeps task-only completed replies visible when foldWorkRuns=%s", (foldWorkRuns) => {
    const anchor = { ...message, content: "" };
    const entries = buildConversationTimeline([run], [step], [anchor], [], [], { foldWorkRuns });
    expect(cards(entries)).toHaveLength(1);
    expect(entries.find((entry) => entry.kind === "agent")).toMatchObject({ finalReply: true });
    expect(estimateEntryHeight(entries.find((entry) => entry.kind === "agent")!)).toBeGreaterThan(400);
  });

  it("keeps a task card visible before a later completed answer", () => {
    const nextStep = { ...step, id: "step-2", index: 2, startedAt: "2026-10-22T01:00:03Z" };
    const nextReply = { ...message, id: "reply-2", stepId: nextStep.id, metadata: {}, content: "方案已准备好。", createdAt: nextStep.startedAt };
    const entries = buildConversationTimeline([run], [step, nextStep], [message, nextReply], []);
    expect(cards(entries)).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "agent")).toHaveLength(2);
    expect(entries.filter((entry) => entry.kind === "work_log").flatMap((entry) => entry.turns.flatMap((turn) => turn.blocks)))
      .not.toContainEqual(expect.objectContaining({ type: "git_merge" }));
  });

  it("renders an independent live anchor while its producing run is excluded, then restores it from history", () => {
    const anchor = { ...message, runId: null, stepId: null, content: "" };
    const live = buildConversationTimeline([{ ...run, status: "running" }], [step], [anchor], [], [], {
      excludeStepIds: [step.id], excludeRunIds: [run.id],
    });
    const historical = buildConversationTimeline([], [], [anchor], []);
    expect(cards(live)).toEqual(cards(historical));
    expect(cards(live)).toHaveLength(1);
    expect(live[0].id).toBe(historical[0].id);
  });

  it.each([{ steps: [] }, { steps: [step] }])("uses the latest duplicate stable anchor payload with loaded steps $steps", ({ steps }) => {
    const updated = { ...message, metadata: { ...message.metadata, gitMergeTask: { ...reference, title: "合并已完成" } } };
    const entries = buildConversationTimeline([run], steps, [message, updated], []);
    expect(cards(entries)).toHaveLength(1);
    expect(cards(entries)[0]).toMatchObject({ reference: { objectId: reference.objectId, title: "合并已完成" } });
  });

  it("treats action receipts as ordinary text instead of another task card", () => {
    const receipt = { ...message, id: "receipt", runId: null, stepId: null,
      content: "验证通过。", metadata: { source: "git_merge_receipt", gitMergeTask: reference } };
    expect(gitMergeReplyParts(receipt)).toBeNull();
    const entries = buildConversationTimeline([], [], [receipt], []);
    expect(cards(entries)).toEqual([]);
    expect(entries[0]).toMatchObject({ kind: "agent", turn: { blocks: [{ type: "text", content: receipt.content }] } });
  });

  it("does not infer native cards from text, user messages, partial replies, or untrusted schema fields", () => {
    const invalid: AgentRuntimeMessage[] = [
      { ...message, metadata: {}, content: JSON.stringify(reference) },
      { ...message, role: "user" },
      { ...message, role: "tool" },
      ...[{ source: "other" }, { partial: true }, { type: "thinking" }, { kind: "thought" }]
        .map((patch) => ({ ...message, metadata: { ...message.metadata, ...patch } })),
      ...[null, [], "task", { ...reference, schemaVersion: 2 }, { ...reference, schema: "html" },
        { ...reference, sessionId: "other" }, { ...reference, objectId: "" },
        { ...reference, projectId: "p".repeat(257) }, { ...reference, rootId: 1 },
        { ...reference, title: "x".repeat(251) }, { ...reference, title: "a\u0000b" }]
        .map((gitMergeTask) => ({ ...message, metadata: { ...message.metadata, gitMergeTask } })),
    ];
    for (const candidate of invalid) expect(gitMergeReplyParts(candidate)).toBeNull();
  });

  it("scopes task references and the conversation timeline to their owner session", () => {
    expect(gitMergeReplyParts({ ...message, sessionId: "parent" })).toBeNull();
    expect(buildConversationTimeline([], [], [message], [], [], { session: { id: "parent" } as AgentSession })).toEqual([]);
    expect(cards(buildConversationTimeline([], [], [message], [], [], { session: { id: message.sessionId } as AgentSession })))
      .toHaveLength(1);
  });

  it("retains only the validated small reference in the paged navigation index", () => {
    const input = { ...message, content: "x".repeat(300), metadata: {
      ...message.metadata, largePayload: "x".repeat(1000),
      gitMergeTask: { ...reference, untrustedHtml: "<button>Execute</button>" },
    } };
    const preview = previewTimelineMessage(input);
    expect(preview.content).toHaveLength(240);
    expect(preview.metadata.gitMergeTask).toEqual(reference);
    expect(preview.metadata).not.toHaveProperty("largePayload");
    expect(cards(buildConversationTimeline([], [], [preview], []))).toHaveLength(1);
    const mismatch = previewTimelineMessage({ ...input, sessionId: "other" });
    expect(mismatch.metadata).not.toHaveProperty("gitMergeTask");
    expect(timelineContainsEntry({ messages: [preview], steps: [], runs: [] } as unknown as SessionDetailCacheEntry,
      `reply-${message.id}`)).toBe(true);
  });

  it("restores an anchor from an older history page without duplicating an overlapping updated card", () => {
    const latestMessage = { ...message, stepId: null, runId: null, metadata: {
      ...message.metadata, gitMergeTask: { ...reference, title: "最新合并状态" },
    } };
    const latest: HistoryWindowResponse = {
      messages: [latestMessage], runs: [], steps: [], toolCalls: [], events: [], permissions: [],
      historyWindow: { revision: 2, epoch: 1, hasEarlier: true, latest: true, detailsTruncated: false, olderCursor: "older" },
    };
    const current = { ...latest, cachedAt: 1, ...seedTimelineIndex(latest) } as SessionDetailCacheEntry;
    const older: HistoryWindowResponse = {
      ...latest, messages: [{ ...message, stepId: null, runId: null }],
      historyWindow: { revision: 1, epoch: 1, hasEarlier: false, latest: false, detailsTruncated: false },
    };
    const index = extendTimelineIndex(current, older);
    const entries = buildConversationTimeline([], [], index.timelineMessages!, []);
    expect(cards(entries)).toHaveLength(1);
    expect(cards(entries)[0]).toMatchObject({ reference: { title: "最新合并状态" } });
    expect(index.timelineIndexLoaded).toBe(true);
  });
});
