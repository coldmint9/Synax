import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flushSession: vi.fn(async () => {}),
  getSession: vi.fn(),
  listMessages: vi.fn(),
  historyCommand: vi.fn(async (_input: unknown) => ({})),
}));

vi.mock("../session-store.js", () => ({
  agentRuntimeStore: {
    flushSession: mocks.flushSession,
    getSession: mocks.getSession,
    listMessages: mocks.listMessages,
  },
}));
vi.mock("../sidecar/runtime-facade.js", () => ({
  runtimeFacade: { historyCommand: mocks.historyCommand },
}));

import { captureCompletedReply } from "../runtime-history.js";

const session = {
  id: "s",
  parentSessionId: null,
  prompt: "Fix the search module",
  contextSnapshotId: "ctx-1",
  sessionMetadata: { permissionTier: "full", historyRevision: 3 },
};

function message(
  id: string,
  role: "user" | "assistant",
  metadata: Record<string, unknown> = {},
) {
  return {
    id,
    sessionId: "s",
    runId: "run-1",
    role,
    content: id,
    stepId: role === "assistant" ? "step-1" : null,
    metadata,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("captureCompletedReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockReturnValue(session);
  });

  it("pins only the settled reply instead of every step", async () => {
    mocks.listMessages.mockReturnValue([
      message("msg-user", "user"),
      message("msg-thought", "assistant", { type: "thinking" }),
      message("msg-partial", "assistant", { partial: true }),
      message("msg-answer", "assistant"),
      message("msg-artifact", "assistant", { source: "artifact_publisher" }),
    ]);

    await captureCompletedReply("s");

    expect(mocks.historyCommand).toHaveBeenCalledTimes(1);
    expect(mocks.historyCommand.mock.calls[0][0]).toMatchObject({
      sessionId: "s",
      operation: "file_checkpoint",
      payload: {
        pinId: "rust_checkpoint_reply_msg-answer",
        metadata: {
          kind: "reply",
          messageId: "msg-answer",
          stepId: "step-1",
        },
      },
    });
  });

  it("does not pin a reply when nothing but process output was persisted", async () => {
    mocks.listMessages.mockReturnValue([
      message("msg-user", "user"),
      message("msg-thought", "assistant", { type: "thinking" }),
    ]);

    await captureCompletedReply("s");

    expect(mocks.historyCommand).not.toHaveBeenCalled();
  });

  it("leaves subagent sessions to their parent history", async () => {
    mocks.getSession.mockReturnValue({ ...session, parentSessionId: "parent" });
    mocks.listMessages.mockReturnValue([message("msg-answer", "assistant")]);

    await captureCompletedReply("s");

    expect(mocks.historyCommand).not.toHaveBeenCalled();
  });

  it("does not pin an earlier run's reply when the current run has no final answer", async () => {
    mocks.listMessages.mockReturnValue([
      message("previous-answer", "assistant"),
      { ...message("partial-answer", "assistant", { partial: true }), runId: "run-2" },
    ]);

    await captureCompletedReply("s", "run-2");

    expect(mocks.historyCommand).not.toHaveBeenCalled();
  });
});
