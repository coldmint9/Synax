import { create } from "zustand";
import type {
  AgentRun,
  AgentRuntimeMessage,
} from "../../../../lib/api/agentRuntime";

export interface PendingSubmission {
  requestId: string;
  message: AgentRuntimeMessage;
  run?: AgentRun;
}

export const usePendingSubmissionStore = create<{
  items: Record<string, PendingSubmission>;
  begin: (sessionId: string, pending: PendingSubmission) => void;
  accept: (sessionId: string, requestId: string, run: AgentRun) => void;
  clear: (sessionId: string, requestId: string) => void;
}>((set) => ({
  items: {},
  begin: (sessionId, pending) =>
    set((state) => ({ items: { ...state.items, [sessionId]: pending } })),
  accept: (sessionId, requestId, run) =>
    set((state) => {
      const pending = state.items[sessionId];
      return pending?.requestId === requestId
        ? { items: { ...state.items, [sessionId]: { ...pending, run } } }
        : state;
    }),
  clear: (sessionId, requestId) =>
    set((state) => {
      if (state.items[sessionId]?.requestId !== requestId) return state;
      const items = { ...state.items };
      delete items[sessionId];
      return { items };
    }),
}));

export function projectPendingSubmission(
  pending: PendingSubmission | undefined,
  runs: AgentRun[],
  messages: AgentRuntimeMessage[],
) {
  if (!pending) return { messages, confirmed: false, run: undefined };
  const run =
    runs.find(
      (item) =>
        item.id === pending.run?.id ||
        (item.metadata?.runtime as { requestId?: string } | undefined)
          ?.requestId === pending.requestId,
    ) ?? pending.run;
  const confirmed = Boolean(
    run &&
    messages.some(
      (message) =>
        message.role === "user" &&
        (message.id === run.triggerMessageId || message.runId === run.id),
    ),
  );
  return {
    messages: confirmed ? messages : [...messages, pending.message],
    confirmed,
    run,
  };
}
