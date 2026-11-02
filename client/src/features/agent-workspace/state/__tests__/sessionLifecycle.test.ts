import { describe, expect, it } from "vitest";
import { EMPTY_STREAMING_BUFFERS } from "../../streamingLiveBlocks";
import {
  readReplyActivity,
  sessionLifecycleTransition,
  sessionPhase,
  type SessionLifecycleSnapshot,
} from "../sessionLifecycle";

const snapshot = (
  overrides: Partial<SessionLifecycleSnapshot> = {},
): SessionLifecycleSnapshot => ({
  activeTurn: true,
  stepId: "step-1",
  hasReplyText: false,
  hasToolCall: false,
  ...overrides,
});

describe("readReplyActivity", () => {
  it("treats streamed assistant text as a reply", () => {
    expect(
      readReplyActivity(
        { ...EMPTY_STREAMING_BUFFERS, pendingText: "正在检查配置" },
        "step-1",
        true,
      ),
    ).toEqual(
      snapshot({ hasReplyText: true }),
    );
  });

  it("keeps text flushed into blocks before a tool call as a reply signal", () => {
    const activity = readReplyActivity(
      {
        blocks: [{ type: "text", content: "我先看一下" }],
        pendingThinking: "",
        pendingText: "",
        pendingToolCalls: [],
      },
      "step-1",
      true,
    );
    expect(activity.hasReplyText).toBe(true);
    expect(activity.hasToolCall).toBe(false);
  });

  it("reports tool work even when the step also wrote a preamble", () => {
    const activity = readReplyActivity(
      {
        blocks: [{ type: "text", content: "我先看一下" }],
        pendingThinking: "",
        pendingText: "",
        pendingToolCalls: [{} as never],
      },
      "step-1",
      true,
    );
    expect(activity.hasToolCall).toBe(true);
  });

  it("has no reply signal without a streaming step", () => {
    expect(
      readReplyActivity(
        { ...EMPTY_STREAMING_BUFFERS, pendingText: "text" },
        null,
        false,
      ),
    ).toEqual(snapshot({ activeTurn: false, stepId: null }));
  });
});

describe("sessionPhase", () => {
  it("starts idle and only becomes settled after a turn", () => {
    expect(sessionPhase(snapshot({ activeTurn: false }), "idle")).toBe("idle");
    expect(sessionPhase(snapshot({ activeTurn: false }), "working")).toBe(
      "settled",
    );
  });

  it("derives working and replying while the turn is active", () => {
    expect(sessionPhase(snapshot(), "settled")).toBe("working");
    expect(sessionPhase(snapshot({ hasReplyText: true }), "working")).toBe(
      "replying",
    );
  });
});

describe("sessionLifecycleTransition", () => {
  it("announces the reply phase at its first assistant text", () => {
    expect(
      sessionLifecycleTransition(snapshot(), snapshot({ hasReplyText: true })),
    ).toBe("reply_started");
  });

  it("cancels the reply when the same step asks for a tool", () => {
    expect(
      sessionLifecycleTransition(
        snapshot({ hasReplyText: true }),
        snapshot({ hasReplyText: true, hasToolCall: true }),
      ),
    ).toBe("reply_cancelled");
  });

  it("does not cancel on a step switch", () => {
    expect(
      sessionLifecycleTransition(
        snapshot({ hasReplyText: true }),
        snapshot({ stepId: "step-2" }),
      ),
    ).toBe(null);
  });

  it("settles when the turn stops being active", () => {
    expect(
      sessionLifecycleTransition(
        snapshot({ hasReplyText: true }),
        snapshot({ activeTurn: false }),
      ),
    ).toBe("turn_settled");
  });

  it("announces a new turn so stale guesses can be dropped", () => {
    expect(
      sessionLifecycleTransition(
        snapshot({ activeTurn: false }),
        snapshot({ activeTurn: true }),
      ),
    ).toBe("turn_started");
  });

  it("is quiet while a settled session stays idle", () => {
    expect(
      sessionLifecycleTransition(
        snapshot({ activeTurn: false }),
        snapshot({ activeTurn: false }),
      ),
    ).toBeNull();
  });
});
