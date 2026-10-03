import { assertBatchInput } from "./checkpoints/version-runtime/batch-input.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import type { RuntimeEvent, RuntimeEventType } from "./contracts.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { agentRuntimeStore, type AgentRuntimeStore } from "./session-store.js";

export class AgentEventService {
  constructor(private readonly store: AgentRuntimeStore = agentRuntimeStore) {}

  append(input: {
    sessionId: string;
    type: RuntimeEventType;
    summary: string;
    payload?: Record<string, unknown>;
    visibility?: RuntimeEvent["visibility"];
  }): RuntimeEvent {
    let workId: unknown;
    try {
      workId = this.store.getSession(input.sessionId).sessionMetadata
        ?.activeWorkId;
    } catch {
      /* session creation event */
    }
    return this.store.appendEvent({
      id: makeRuntimeId("evt"),
      sessionId: input.sessionId,
      type: input.type,
      timestamp: nowIso(),
      visibility: input.visibility ?? "user_visible",
      summary: input.summary,
      payload: {
        ...(typeof workId === "string" ? { workId } : {}),
        ...input.payload,
      },
    });
  }

  /** Batch only explicitly grouped input; no delayed acknowledgement or queue. */
  appendBatch(
    inputs: readonly {
      sessionId: string;
      type: RuntimeEventType;
      summary: string;
      payload?: Record<string, unknown>;
      visibility?: RuntimeEvent["visibility"];
    }[],
  ): RuntimeEvent[] {
    if (!Array.isArray(inputs) || inputs.length > 256)
      throw new AgentRuntimeError(
        "Event batch row limit exceeded.",
        "VERSION_BATCH_LIMIT",
        413,
      );
    assertBatchInput(inputs);
    if (!inputs.length) return [];
    const sessionId = inputs[0].sessionId;
    if (inputs.some((input) => input.sessionId !== sessionId))
      throw new AgentRuntimeError(
        "Event batch must belong to one session.",
        "VERSION_BATCH_SESSION",
        409,
      );
    const workId =
      this.store.getSession(sessionId).sessionMetadata?.activeWorkId;
    return this.store.appendEvents(
      inputs.map((input) => ({
        id: makeRuntimeId("evt"),
        sessionId,
        type: input.type,
        timestamp: nowIso(),
        visibility: input.visibility ?? "user_visible",
        summary: input.summary,
        payload: {
          ...(typeof workId === "string" ? { workId } : {}),
          ...input.payload,
        },
      })),
    );
  }

  list(sessionId: string, after?: string): RuntimeEvent[] {
    return this.store.listEvents(sessionId, after);
  }
}

export const agentEventService = new AgentEventService();
