import { describe, expect, it } from "vitest";
import { groupActivityEntries } from "../groupActivityEntries";
import type { ConversationTimelineEntry } from "../buildConversationTimeline";
import type { TurnContentBlock } from "../buildInterleavedTurns";

function entry(
  id: string,
  blocks: TurnContentBlock[],
): ConversationTimelineEntry {
  return {
    id,
    kind: "agent",
    createdAt: "",
    label: "",
    turn: {
      stepId: id,
      index: 0,
      status: "completed",
      duration: null,
      completedAt: null,
      blocks,
    },
  };
}
function text(content: string, messageId?: string): TurnContentBlock {
  return { type: "text", content, ...(messageId ? { messageId } : {}) };
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeDeep(child);
  }
  return value;
}
const tool = (id: string): TurnContentBlock => ({
  type: "tool_call",
  call: {
    id,
    toolId: "file.read",
    inputSummary: id,
    outputSummary: "",
    status: "completed",
    category: "read",
    mutability: "read",
    duration: null,
  },
});

describe("groupActivityEntries", () => {
  it("keeps one stable group across model steps without changing source blocks", () => {
    const first = freezeDeep(entry("one", [tool("a")]));
    const initial = freezeDeep(groupActivityEntries([first]));
    const initialSnapshot = structuredClone(initial);
    const result = groupActivityEntries([
      first,
      entry("two", [{ type: "thinking", content: "next" }, tool("b")]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(initial[0].id);
    expect(result[0].kind === "agent" && result[0].turn.blocks).toHaveLength(3);
    expect(first.kind === "agent" && first.turn.blocks).toHaveLength(1);
    expect(initial).toEqual(initialSnapshot);
  });
  it("ends a group at reply output and starts another after it", () => {
    const result = groupActivityEntries([
      entry("one", [tool("a")]),
      entry("two", [tool("b"), { type: "text", content: "Reply" }, tool("c")]),
    ]);
    expect(result).toHaveLength(3);
    expect(
      result.map((row) =>
        row.kind === "agent" ? row.turn.blocks.map((block) => block.type) : [],
      ),
    ).toEqual([["tool_call", "tool_call"], ["text"], ["tool_call"]]);
  });
  it("does not merge across user messages and ignores empty text", () => {
    const user: ConversationTimelineEntry = {
      id: "user",
      kind: "user",
      createdAt: "",
      label: "",
      content: "Continue",
    };
    const result = groupActivityEntries([
      entry("one", [tool("a"), { type: "text", content: "  " }, tool("b")]),
      user,
      entry("two", [tool("c")]),
    ]);
    expect(result).toHaveLength(3);
    expect(result[1]).toBe(user);
  });

  it("merges same-message reply chunks without mutating source or prior output", () => {
    const source = freezeDeep([
      entry("one", [text("first", "message-1")]),
      entry("two", [text("second", "message-1")]),
    ]);
    const result = groupActivityEntries(source);

    expect(result).toHaveLength(1);
    expect(result[0].kind === "agent" && result[0].turn.blocks).toEqual([
      text("first", "message-1"),
      text("second", "message-1"),
    ]);

    const prior = freezeDeep(
      groupActivityEntries([entry("prior", [text("old", "m")])]),
    );
    const priorSnapshot = structuredClone(prior);
    groupActivityEntries([
      ...prior,
      entry("next", [text("new", "m")]),
    ]);
    expect(prior).toEqual(priorSnapshot);
  });

  it("retains activity identity and the latest contributing step status", () => {
    const first = entry("one", [text("  "), tool("a")]);
    const next = entry("two", [
      { type: "thinking", content: "reasoning" },
      { type: "tool_call_group", calls: [] },
    ]);
    if (next.kind === "agent") next.turn.status = "running";
    const result = groupActivityEntries(freezeDeep([first, next]));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "one:activity:1",
      turn: { stepId: "one", status: "running" },
    });
    expect(result[0].kind === "agent" && result[0].turn.blocks).toEqual([
      tool("a"),
      { type: "thinking", content: "reasoning" },
      { type: "tool_call_group", calls: [] },
    ]);
  });

  it("keeps same-message parts together but respects activity and system boundaries", () => {
    const system: ConversationTimelineEntry = {
      id: "model-change",
      kind: "model_switch",
      createdAt: "",
      label: "",
      fromModel: "old",
      toModel: "new",
    };
    const result = groupActivityEntries(freezeDeep([
      entry("one", [text("first", "m")]),
      entry("two", [
        { type: "sources", messageId: "m", sources: [] },
        text("  ", "m"),
        { type: "media", messageId: "m", parts: [] },
        text("different", "n"),
        tool("a"),
        text("after activity", "n"),
      ]),
      system,
      entry("three", [text("after system", "n"), tool("b")]),
    ]));

    expect(result.map((row) => row.id)).toEqual([
      "one:content:0",
      "two:content:0",
      "two:activity:4",
      "two:content:1",
      "model-change",
      "three:content:0",
      "three:activity:1",
    ]);
    expect(result[0].kind === "agent" && result[0].turn.blocks).toEqual([
      text("first", "m"),
      { type: "sources", messageId: "m", sources: [] },
      { type: "media", messageId: "m", parts: [] },
    ]);
    expect(result[4]).toBe(system);
  });

  it("does not merge adjacent reply blocks without a message identity", () => {
    const result = groupActivityEntries([
      entry("one", [text("first"), text("second")]),
      entry("two", [text("third")]),
    ]);
    expect(result.map((row) => row.id)).toEqual([
      "one:content:0",
      "one:content:1",
      "two:content:0",
    ]);
  });

  it("handles increasing long activity groups with invocation-owned arrays", () => {
    for (const size of [32, 128, 512, 2048]) {
      const inputBlocks = Array.from({ length: size }, (_, index) =>
        tool(`${size}-${index}`),
      );
      const input = freezeDeep(entry(`long-${size}`, inputBlocks));
      const result = groupActivityEntries([input]);

      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe("agent");
      if (result[0].kind === "agent") {
        expect(result[0].turn.blocks).toHaveLength(size);
        expect(result[0].turn.blocks).not.toBe(inputBlocks);
        expect(result[0].turn.blocks[0]).toBe(inputBlocks[0]);
        expect(result[0].turn.blocks[size - 1]).toBe(inputBlocks[size - 1]);
      }

      const replyBlocks = Array.from({ length: size }, (_, index) =>
        text(`part ${index}`, "reply"),
      );
      const replies = groupActivityEntries([
        freezeDeep(entry(`reply-${size}`, replyBlocks)),
      ]);
      expect(replies).toHaveLength(1);
      if (replies[0].kind === "agent") {
        expect(replies[0].turn.blocks).toEqual(replyBlocks);
        expect(replies[0].turn.blocks).not.toBe(replyBlocks);
      }
    }
  });
});
