import { beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore, onSessionRetired } from "../session-store.js";
import {
  explorerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

const analytics = { version: 3, steps: 2, toolCalls: 4 };
const contextUsage = { version: 1, source: "provider", total: 900 };

describe("session retirement notification", () => {
  beforeEach(resetAgentRuntimeFixtures);

  it("hands archiving and deleting the last statistics snapshot", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    agentRuntimeStore.updateSessionMetadata(session.id, {
      runtimeAnalytics: analytics,
      contextUsage,
    });
    const events: Array<{
      id: string;
      reason: string;
      analytics: unknown;
      contextUsage: unknown;
    }> = [];
    const off = onSessionRetired(({ session: retired, reason }) => {
      events.push({
        id: retired.id,
        reason,
        analytics: retired.sessionMetadata?.runtimeAnalytics,
        contextUsage: retired.sessionMetadata?.contextUsage,
      });
    });
    try {
      agentRuntimeStore.archiveSessionTree(session.id);
      expect(events).toEqual([
        {
          id: session.id,
          reason: "archived",
          analytics,
          contextUsage,
        },
      ]);
      // The archive batch expiry path deletes through the same hook.
      agentRuntimeStore.deleteArchivedBatch(session.id);
      expect(events.map((event) => event.reason)).toEqual([
        "archived",
        "deleted",
      ]);
      expect(events[1]).toMatchObject({ id: session.id, analytics });
    } finally {
      off();
    }
  });

  it("never lets a failing listener break archiving or deleting", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const off = onSessionRetired(() => {
      throw new Error("listener boom");
    });
    try {
      expect(() => agentRuntimeStore.archiveSessionTree(session.id)).not.toThrow();
      expect(() =>
        agentRuntimeStore.deleteArchivedBatch(session.id),
      ).not.toThrow();
    } finally {
      off();
    }
  });
});
