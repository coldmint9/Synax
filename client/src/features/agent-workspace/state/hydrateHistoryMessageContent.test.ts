import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeMessage } from "../../../adapters/transport/agentRuntime";
import { agentRuntimeApi } from "../../../adapters/transport/agentRuntime";
import { hydrateHistoryMessageContent } from "./hydrateHistoryMessageContent";

const message = (id: string, content: string): AgentRuntimeMessage => ({
  id,
  sessionId: "session",
  runId: null,
  stepId: null,
  role: "assistant",
  content,
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  historyProjection: { omittedFields: ["content", "metadata"] },
});

describe("hydrateHistoryMessageContent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loads every content page and preserves the other projected fields", async () => {
    vi.spyOn(agentRuntimeApi, "messageContentPage")
      .mockResolvedValueOnce({ text: "first ", next: 6, revision: 4 })
      .mockResolvedValueOnce({ text: "second", revision: 4 });

    const [result] = await hydrateHistoryMessageContent(
      "session",
      [message("message", "preview")],
      4,
    );

    expect(result.content).toBe("first second");
    expect(result.historyProjection?.omittedFields).toEqual(["metadata"]);
    expect(agentRuntimeApi.messageContentPage).toHaveBeenNthCalledWith(
      2,
      "session",
      "message",
      6,
      4,
    );
  });

  it("does not request content for complete messages", async () => {
    const page = vi.spyOn(agentRuntimeApi, "messageContentPage");
    const complete = { ...message("complete", "full"), historyProjection: undefined };

    await expect(
      hydrateHistoryMessageContent("session", [complete], 4),
    ).resolves.toEqual([complete]);
    expect(page).not.toHaveBeenCalled();
  });

  it("reuses a previously hydrated body during a refresh", async () => {
    const page = vi.spyOn(agentRuntimeApi, "messageContentPage");
    const projected = message("message", "preview");
    const cached = {
      ...projected,
      content: "already loaded",
      historyProjection: { omittedFields: ["metadata"] },
    };

    const [result] = await hydrateHistoryMessageContent(
      "session",
      [projected],
      4,
      [cached],
    );

    expect(result.content).toBe("already loaded");
    expect(page).not.toHaveBeenCalled();
  });
});
