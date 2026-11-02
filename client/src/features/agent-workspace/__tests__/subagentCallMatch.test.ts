import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
import type { ToolCallView, TurnContentBlock } from "../buildInterleavedTurns";
import {
  childForSubagentCall,
  isSubagentDelegationCall,
  readSubagentSessionId,
  withSubagentCards,
} from "../subagentCallMatch";

const PARENT = "parent-1";

function child(id: string, createdAt: string, parentSessionId = PARENT) {
  return { id, parentSessionId, createdAt, status: "running" } as AgentSession;
}

function call(partial: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "call-1",
    toolId: "subagent.delegate",
    inputSummary: "前端筛查",
    outputSummary: "",
    status: "running",
    category: "task",
    duration: null,
    mutability: "task",
    ...partial,
  };
}

const toolBlock = (value: ToolCallView): TurnContentBlock => ({
  type: "tool_call",
  call: value,
});

describe("subagent delegation records", () => {
  it("recognizes both delegation tools and ignores ordinary calls", () => {
    expect(isSubagentDelegationCall({ toolId: "subagent.delegate" })).toBe(true);
    expect(isSubagentDelegationCall({ toolId: "subagent.lifecycle" })).toBe(true);
    expect(isSubagentDelegationCall({ toolId: "file.read" })).toBe(false);
  });

  it("reads the child id from every shape a record exposes", () => {
    expect(readSubagentSessionId({ childSessionId: "c-1" })).toBe("c-1");
    expect(readSubagentSessionId({ taskId: "c-2" })).toBe("c-2");
    expect(readSubagentSessionId({ result: { childSessionId: "c-3" } })).toBe("c-3");
    expect(readSubagentSessionId({ session: { id: "c-4" } })).toBe("c-4");
    expect(readSubagentSessionId({ summary: "no id here" })).toBeNull();
  });

  it("keeps an explicit child ahead of the time heuristic", () => {
    const children = [
      child("early", "2026-01-01T00:00:01.000Z"),
      child("named", "2026-01-01T00:05:00.000Z"),
    ];
    const matched = childForSubagentCall(
      { childSessionId: "named", startedAt: "2026-01-01T00:00:02.000Z" },
      PARENT,
      children,
      new Set(),
    );
    expect(matched?.id).toBe("named");
  });
});

describe("live subagent cards", () => {
  it("leaves the rows untouched while no child is known", () => {
    const blocks = [toolBlock(call())];
    expect(withSubagentCards(blocks, { parentSessionId: PARENT })).toEqual(blocks);
  });

  it("attaches the card to the call that carries the child id", () => {
    const running = child("child-a", "2026-01-01T00:00:20.000Z");
    const blocks = [toolBlock(call({ childSessionId: running.id }))];
    const rows = withSubagentCards(blocks, {
      parentSessionId: PARENT,
      childSessions: [running],
    });
    expect(rows.map((row) => row.type)).toEqual(["tool_call", "sub_session"]);
    expect(rows[1]).toMatchObject({ type: "sub_session", session: { id: running.id } });
  });

  it("matches a blocking delegate that has no id yet by its start time", () => {
    const first = child("child-1", "2026-01-01T00:00:03.000Z");
    const second = child("child-2", "2026-01-01T00:00:40.000Z");
    const rows = withSubagentCards(
      [
        toolBlock(call({ id: "call-1", startedAt: "2026-01-01T00:00:02.000Z" })),
        toolBlock(call({ id: "call-2", startedAt: "2026-01-01T00:00:41.000Z" })),
      ],
      { parentSessionId: PARENT, childSessions: [first, second] },
    );
    expect(rows.filter((row) => row.type === "sub_session")).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: "sub_session", session: { id: "child-1" } });
    expect(rows[3]).toMatchObject({ type: "sub_session", session: { id: "child-2" } });
  });

  it("renders one card per child even when several calls name it", () => {
    const running = child("child-a", "2026-01-01T00:00:20.000Z");
    const rows = withSubagentCards(
      [
        toolBlock(call({ id: "start", childSessionId: running.id })),
        toolBlock(call({ id: "wait", toolId: "subagent.lifecycle", childSessionId: running.id })),
      ],
      { parentSessionId: PARENT, childSessions: [running] },
    );
    expect(rows.filter((row) => row.type === "sub_session")).toHaveLength(1);
    // The card follows the call that started the child, not the later wait.
    expect(rows.map((row) => row.type)).toEqual([
      "tool_call",
      "sub_session",
      "tool_call",
    ]);
  });

  it("does not re-attach a child the live snapshot already rendered", () => {
    const running = child("child-a", "2026-01-01T00:00:20.000Z");
    const rows = withSubagentCards(
      [
        toolBlock(call({ childSessionId: running.id })),
        { type: "sub_session", session: running },
      ],
      { parentSessionId: PARENT, childSessions: [running] },
    );
    expect(rows.filter((row) => row.type === "sub_session")).toHaveLength(1);
  });

  it("never hands an already-carded child to a later lifecycle record", () => {
    const running = child("child-a", "2026-01-01T00:00:20.000Z");
    const idle = child("child-b", "2026-01-01T00:00:50.000Z");
    const rows = withSubagentCards(
      [
        toolBlock(call({ id: "start", childSessionId: running.id })),
        toolBlock(
          call({
            id: "wait",
            toolId: "subagent.lifecycle",
            childSessionId: running.id,
            startedAt: "2026-01-01T00:00:21.000Z",
          }),
        ),
      ],
      { parentSessionId: PARENT, childSessions: [running, idle] },
    );
    expect(
      rows.flatMap((row) => (row.type === "sub_session" ? [row.session.id] : [])),
    ).toEqual([running.id]);
  });

  it("ignores a child that belongs to another parent", () => {
    const foreign = child("child-x", "2026-01-01T00:00:20.000Z", "other-parent");
    const rows = withSubagentCards([toolBlock(call())], {
      parentSessionId: PARENT,
      childSessions: [foreign],
    });
    expect(rows.some((row) => row.type === "sub_session")).toBe(false);
  });
});
