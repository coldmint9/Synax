import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentRuntimeApi, type AgentRun, type AgentSession } from "../../../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "../agentSessionStore";
import { ConversationController } from "../conversationController";
import { conversationActions } from "../conversationActions";
import { usePendingSubmissionStore } from "../pendingSubmissionStore";

const side = { id: "side", parentSessionId: "parent", projectId: "p", status: "completed", activeRunId: null,
  sessionMetadata: { subagentKind: "side-chat" } } as AgentSession;
let controller: ConversationController;
beforeEach(() => {
  controller = new ConversationController(side.id);
  controller.seedSession(side);
  vi.spyOn(controller, "refresh").mockResolvedValue();
  usePendingSubmissionStore.setState({ items: {} });
  useAgentSessionStore.setState({ ...useAgentSessionStore.getInitialState(), selectedSessionId: "parent", sessions: [] });
});
afterEach(() => { vi.restoreAllMocks(); usePendingSubmissionStore.setState({ items: {} }); });

it("sends an optimistic child turn without list insertion or parent selection changes", async () => {
  const run = { id: "side-run", sessionId: side.id, status: "queued" } as AgentRun;
  let resolve!: (value: { run: AgentRun; reused: boolean }) => void;
  const submit = vi.spyOn(agentRuntimeApi, "submitRun").mockReturnValue(new Promise(done => { resolve = done; }));
  const sending = conversationActions(controller).submitOrEnqueueSessionInput(side.id, { message: "Question about parent history" });
  expect(usePendingSubmissionStore.getState().items.side?.message.content).toBe("Question about parent history");
  resolve({ run, reused: false });
  expect(await sending).toBe("sent");
  expect(submit).toHaveBeenCalledWith(side.id, expect.objectContaining({ message: "Question about parent history" }), expect.any(String), "continue");
  expect(controller.getSnapshot().session).toMatchObject({ status: "running", activeRunId: run.id });
  expect(useAgentSessionStore.getState().selectedSessionId).toBe("parent");
  expect(useAgentSessionStore.getState().sessions).toEqual([]);
});

it("queues against the child while it runs without submitting a second simultaneous run", async () => {
  controller.acceptRun({ id: "run", sessionId: side.id, status: "running" } as AgentRun);
  const enqueue = vi.spyOn(agentRuntimeApi, "enqueueInput").mockResolvedValue({ items: [] });
  vi.spyOn(agentRuntimeApi, "listInputQueue").mockResolvedValue({ items: [] });
  const submit = vi.spyOn(agentRuntimeApi, "submitRun");
  expect(await conversationActions(controller).submitOrEnqueueSessionInput(side.id, { message: "Follow-up" })).toBe("queued");
  expect(enqueue).toHaveBeenCalledWith(side.id, { message: "Follow-up" });
  expect(submit).not.toHaveBeenCalled();
});

it("removes the optimistic child message on rejection and keeps the error retryable", async () => {
  vi.spyOn(agentRuntimeApi, "submitRun").mockRejectedValue(new Error("Not available"));
  await expect(conversationActions(controller).submitOrEnqueueSessionInput(side.id, { message: "Retry me" })).rejects.toThrow("Not available");
  expect(usePendingSubmissionStore.getState().items.side).toBeUndefined();
  expect(controller.getSnapshot().session).toBe(side);
});

it("cancels only the child run and reconciles its controller", async () => {
  controller.acceptRun({ id: "run", sessionId: side.id, status: "running" } as AgentRun);
  const cancel = vi.spyOn(agentRuntimeApi, "cancelSession").mockResolvedValue({ session: side } as never);
  await conversationActions(controller).cancelSessionRun(side.id);
  expect(cancel).toHaveBeenCalledWith(side.id, "run");
  expect(controller.refresh).toHaveBeenCalledOnce();
  await expect(conversationActions(controller).cancelSessionRun("parent")).rejects.toThrow("scope changed");
  expect(cancel).toHaveBeenCalledTimes(1);
});
