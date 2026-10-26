import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentSessionStore } from "../../state/agentSessionStore";
import {
  applyDockLiveEvent,
  applyDockSessionPatch,
  applyDockStreamChunk,
  initialDockSessionState,
  type DockSessionState,
} from "../dockSessionStream";
import type { SessionLiveEvent } from "../../../../adapters/transport/sessionLive";

function state(status: DockSessionState["status"]): DockSessionState {
  return { ...initialDockSessionState, sessionId: "s1", status };
}

/** The store backs the "is a form still open" question the dock asks. */
function setForm(status: "pending" | "answered"): void {
  useAgentSessionStore.setState({
    interactionState: {
      sessionId: "s1",
      items: [
        {
          id: "hitl-1",
          sessionId: "s1",
          runId: "r1",
          stepId: "st1",
          toolCallId: "tc1",
          kind: "clarification",
          revision: 1,
          status,
          request: { title: "Pick a file" },
          response: null,
          createdAt: "2026-10-19T00:00:00.000Z",
          resolvedAt: null,
        },
      ],
      loading: false,
      error: null,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  useAgentSessionStore.setState({ interactionState: null });
});

const toolCall = {
  id: "tc1",
  sessionId: "s1",
  runId: "r1",
  stepId: "st1",
  modelToolCallId: "call-1",
  toolId: "human.ask",
  category: "task",
  mutability: "read",
  argsHash: "h",
  inputSummary: "human.ask",
  inputRef: {},
  outputSummary: null,
  outputRef: null,
  status: "pending",
  permissionDecisionId: null,
  startedAt: "2026-10-19T00:00:00.000Z",
  endedAt: null,
  error: null,
} as const;

/** The dock renders the waiting state a human must act on, so a checkpoint
 *  must never be lost to a stale "running" or "completed" shortcut. */
describe("dock session status", () => {
  it("refreshes the dock queue after automatic consumption without a selected transcript", async () => {
    const loadQueue = vi.spyOn(useAgentSessionStore.getState(), "loadInputQueue").mockResolvedValue();
    useAgentSessionStore.setState({ selectedSessionId: null });
    const current = state("running");
    expect(applyDockLiveEvent(current, { type: "input_queue_changed", sessionId: "s1", queueRevision: 2 })).toBe(current);
    expect(loadQueue).toHaveBeenCalledWith("s1");
    applyDockLiveEvent(current, { type: "input_queue_changed", sessionId: "other", queueRevision: 2 });
    expect(loadQueue).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting_input when the session patch reports it", () => {
    expect(applyDockSessionPatch(state("running"), { status: "waiting_input" }))
      .toMatchObject({ status: "waiting_input" });
  });

  it("does not let a stale running patch erase a form the human must answer", () => {
    // The run is parked on the form, so nothing but the reply can resume it.
    setForm("pending");
    expect(
      applyDockSessionPatch(state("waiting_input"), { status: "running" }),
    ).toMatchObject({ status: "waiting_input" });
    // A permission prompt resolves through its own record and legitimately
    // returns the run to `running`.
    expect(
      applyDockSessionPatch(state("waiting_permission"), { status: "running" }),
    ).toMatchObject({ status: "running" });
  });

  it("resumes once the form is answered", () => {
    setForm("answered");
    expect(
      applyDockSessionPatch(state("waiting_input"), { status: "running" }),
    ).toMatchObject({ status: "running" });
  });

  it("leaves a checkpoint alone when a stream ends on it", () => {
    for (const status of ["waiting_input", "waiting_permission"] as const)
      expect(applyDockStreamChunk(state(status), { type: "done" })).toEqual(
        state(status),
      );
  });

  it.each([
    ["tool_call", { type: "tool_call", toolCall }],
    ["step_started", { type: "step_started" }],
  ])("does not resume a parked checkpoint on %s", (_label, chunk) => {
    expect(applyDockStreamChunk(state("waiting_input"), chunk)).toMatchObject({
      status: "waiting_input",
    });
  });

  it("adopts the waiting_input patch a stream record carries", () => {
    // The dock subscribes to the session's runtime stream; the record's
    // authoritative patch is the only event that reports a form.
    const event = {
      type: "runtime_state",
      sessionId: "s1",
      patch: { status: "waiting_input" },
      reset: false,
      refresh: true,
    } as SessionLiveEvent;
    expect(applyDockLiveEvent(state("running"), event)).toMatchObject({
      status: "waiting_input",
    });
    // The reply resumes the run, which arrives as a later record.
    setForm("pending");
    const asking = applyDockLiveEvent(state("running"), event);
    setForm("answered");
    const resumed = {
      ...event,
      patch: { status: "running" },
    } as SessionLiveEvent;
    expect(applyDockLiveEvent(asking, resumed)).toMatchObject({
      status: "running",
    });
  });

  it("still reports completion for a finished turn", () => {
    expect(applyDockStreamChunk(state("running"), { type: "run_completed" }))
      .toMatchObject({ status: "completed" });
  });
});
