import { describe, expect, it } from "vitest";
import { groupTimelineIntoTurns, turnPreview } from "../SessionNavigationPanel";
import type { ConversationTimelineEntry } from "../buildConversationTimeline";
import type { InterleavedTurn } from "../buildInterleavedTurns";

function userEntry(
  id: string,
  content: string,
  injected = false,
): ConversationTimelineEntry {
  return {
    id,
    kind: "user",
    createdAt: `2026-09-10T10:00:${id.padStart(2, "0")}.000Z`,
    label: content,
    content,
    ...(injected ? { injected: true } : {}),
  };
}

function agentTurn(
  id: string,
  blocks: InterleavedTurn["blocks"],
): InterleavedTurn {
  return { stepId: id, index: 1, status: "completed", duration: null, blocks };
}

function agentEntry(
  id: string,
  blocks: InterleavedTurn["blocks"],
  label = "",
): ConversationTimelineEntry {
  return {
    id,
    kind: "agent",
    createdAt: `2026-09-10T10:00:${id.padStart(2, "0")}.000Z`,
    label,
    turn: agentTurn(id, blocks),
  };
}

function workLogEntry(
  id: string,
  turns: InterleavedTurn[],
): ConversationTimelineEntry {
  return {
    id,
    kind: "work_log",
    createdAt: `2026-09-10T10:00:${id.padStart(2, "0")}.000Z`,
    label: `Work log · ${turns.length} steps`,
    turns,
    stats: {
      stepCount: turns.length,
      toolCallCount: 0,
      thinkingChars: 0,
      elapsedMs: 0,
    },
  };
}

describe("groupTimelineIntoTurns", () => {
  it("folds every agent step of a turn under the prompt that opened it", () => {
    const turns = groupTimelineIntoTurns([
      userEntry("1", "继续调研"),
      agentEntry("2", [{ type: "thinking", content: "先看代码" }]),
      agentEntry("3", [
        {
          type: "tool_call",
          call: {
            id: "t1",
            toolId: "bash",
            inputSummary: "ls",
            outputSummary: "",
            status: "completed",
            category: "shell",
            duration: "3ms",
            mutability: "read",
          },
        },
      ]),
      agentEntry("4", [{ type: "text", content: "结论如下" }]),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe("1");
    expect(turns[0].members).toHaveLength(4);
  });

  it("starts a new tick only on the next user message", () => {
    const turns = groupTimelineIntoTurns([
      userEntry("1", "继续"),
      agentEntry("2", [{ type: "text", content: "收到" }]),
      workLogEntry("3", [
        agentTurn("s1", [{ type: "thinking", content: "嗯" }]),
        agentTurn("s2", [{ type: "thinking", content: "嗯" }]),
      ]),
      userEntry("4", "再改一处"),
      agentEntry("5", [{ type: "text", content: "完成" }]),
    ]);

    expect(turns.map((turn) => turn.id)).toEqual(["1", "4"]);
    expect(turns[0].members.map((member) => member.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(turns[1].members.map((member) => member.id)).toEqual(["4", "5"]);
  });

  it("keeps leading agent activity as its own first tick", () => {
    const turns = groupTimelineIntoTurns([
      agentEntry("1", [{ type: "text", content: "开场" }]),
      agentEntry("2", [{ type: "thinking", content: "接着想" }]),
      userEntry("3", "继续"),
    ]);

    expect(turns.map((turn) => turn.id)).toEqual(["1", "3"]);
    expect(turns[0].members).toHaveLength(2);
  });

  it("renders no ticks for an empty timeline", () => {
    expect(groupTimelineIntoTurns([])).toEqual([]);
  });
});

describe("turnPreview", () => {
  it("shows the prompt above the last answer of the turn", () => {
    const [turn] = groupTimelineIntoTurns([
      userEntry("1", "重写终端界面"),
      agentEntry("2", [{ type: "thinking", content: "先读代码" }], "先读代码"),
      agentEntry(
        "3",
        [{ type: "text", content: "收到，Ekko。16 个文件已完成。" }],
        "收到，Ekko。…",
      ),
    ]);

    expect(turnPreview(turn)).toEqual({
      title: "重写终端界面",
      body: "收到，Ekko。16 个文件已完成。",
    });
  });

  it("never echoes injected scaffolding and strips the duplicated label stem", () => {
    const [injected] = groupTimelineIntoTurns([
      userEntry("1", "## Language Output Directive\n请用中文回答", true),
      agentEntry("2", [{ type: "text", content: "好" }]),
    ]);
    expect(turnPreview(injected).body).toBe("");

    const [agentHeaded] = groupTimelineIntoTurns([
      agentEntry(
        "1",
        [{ type: "text", content: "收到，Ekko。已修复。" }],
        "收到，Ekko。…",
      ),
    ]);
    expect(turnPreview(agentHeaded)).toEqual({
      title: "收到，Ekko。…",
      body: "已修复。",
    });
  });
});
