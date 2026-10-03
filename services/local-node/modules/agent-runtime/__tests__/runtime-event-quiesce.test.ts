import { describe, expect, it } from "vitest";
import { runtimeBus } from "../runtime-bus.js";
import { sessionLiveBus } from "../session-live-bus.js";
import {
  quiesceSessionEvents,
  withSessionEventsQuiesced,
} from "../runtime-event-quiesce.js";

describe("runtime event quiesce", () => {
  it("drops progress events for quiesced sessions while terminal verdicts pass", () => {
    const events: string[] = [];
    const unsubscribe = runtimeBus.subscribe((event) =>
      events.push(`${event.sessionId}:${event.type}`),
    );
    try {
      const unquiesce = quiesceSessionEvents(["s1"]);
      runtimeBus.emit({ type: "session_changed", sessionId: "s1" });
      runtimeBus.emit({
        type: "session_step_completed",
        sessionId: "s1",
        runId: "r1",
        stepIndex: 1,
      });
      runtimeBus.emit({ type: "session_archived", sessionId: "s1" });
      runtimeBus.emit({ type: "session_changed", sessionId: "s2" });
      unquiesce();
      runtimeBus.emit({ type: "session_changed", sessionId: "s1" });
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([
      "s1:session_archived",
      "s2:session_changed",
      "s1:session_changed",
    ]);
  });

  it("holds live transcript events for quiesced sessions", () => {
    const seen: string[] = [];
    const unsubscribe = sessionLiveBus.subscribe("s1", (event) =>
      seen.push(event.type),
    );
    const unquiesce = quiesceSessionEvents(["s1"]);
    sessionLiveBus.emit("s1", { type: "message_delta", stepId: "st1", delta: "x" });
    unquiesce();
    sessionLiveBus.emit("s1", { type: "message_delta", stepId: "st1", delta: "y" });
    unsubscribe();

    expect(seen).toEqual(["message_delta"]);
  });

  it("unquiesces even when the scoped shutdown fails", async () => {
    await expect(
      withSessionEventsQuiesced(["s1"], async () => {
        throw new Error("shutdown failed");
      }),
    ).rejects.toThrow("shutdown failed");

    const events: string[] = [];
    const unsubscribe = runtimeBus.subscribe((event) =>
      events.push(event.type),
    );
    try {
      runtimeBus.emit({ type: "session_changed", sessionId: "s1" });
    } finally {
      unsubscribe();
    }
    expect(events).toEqual(["session_changed"]);
  });
});
