import { expect, it } from "vitest";
import type { AgentRun, AgentRunStep, AgentRuntimeMessage, ToolCallRecord } from "../../../adapters/transport/agentRuntime";
import { withoutInheritedSnapshot } from "../sideChatTranscript";

const boundary = "2026-10-28T10:00:00.000Z";
const message = (id: string, createdAt: string) => ({ id, createdAt } as AgentRuntimeMessage);
const record = (id: string, startedAt: string) => ({ id, startedAt } as AgentRun);
const step = (id: string, startedAt: string) => ({ id, startedAt } as AgentRunStep);
const call = (id: string, startedAt: string) => ({ id, startedAt } as ToolCallRecord);

const history = {
  messages: [message("inherited", "2026-10-27T09:00:00.000Z"), message("own", "2026-10-28T10:05:00.000Z")],
  runs: [record("inherited-run", "2026-10-27T09:00:00.000Z"), record("own-run", "2026-10-28T10:05:00.000Z")],
  steps: [step("inherited-step", "2026-10-27T09:00:00.000Z"), step("own-step", "2026-10-28T10:05:00.000Z")],
  toolCalls: [call("inherited-call", "2026-10-27T09:00:00.000Z"), call("own-call", "2026-10-28T10:05:00.000Z")],
  sessionStats: { runs: 2 },
};

it("hides every record at or before the snapshot boundary from the side-chat transcript", () => {
  const visible = withoutInheritedSnapshot(history, boundary);
  expect(visible.messages.map(item => item.id)).toEqual(["own"]);
  expect(visible.runs.map(item => item.id)).toEqual(["own-run"]);
  expect(visible.steps.map(item => item.id)).toEqual(["own-step"]);
  expect(visible.toolCalls.map(item => item.id)).toEqual(["own-call"]);
  expect(visible.sessionStats).toBe(history.sessionStats);
});

it("keeps the whole transcript when a boundary is absent", () => {
  expect(withoutInheritedSnapshot(history, null)).toBe(history);
  expect(withoutInheritedSnapshot(history, undefined)).toBe(history);
  expect(withoutInheritedSnapshot(history, "not-a-date")).toBe(history);
});
