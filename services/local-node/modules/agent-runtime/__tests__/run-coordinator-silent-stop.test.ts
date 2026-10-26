import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { RunCoordinator } from "../run-coordinator.js";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

describe("residual stop cleanup", () => {
  beforeEach(async () => {
    await resetAgentRuntimeFixtures();
  });

  it("keeps a failed stop out of the user's way and clears the fence once the process is gone", async () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    let attempts = 0;
    const coordinator = new RunCoordinator({
      execute: vi.fn(),
      interrupt: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1)
          throw new Error(
            "Timed out while waiting for active agent runtime sessions to stop.",
          );
      }),
    });

    // The stop is reported to its caller: delete/archive must not proceed on an
    // unconfirmed process. The user only ever sees the turn as stopped.
    await expect(
      coordinator.interrupt(session.id, "User stopped run.", () =>
        agentSessionRuntime.interrupt(session.id),
      ),
    ).rejects.toThrow(/Timed out/);
    expect(
      (
        agentRuntimeStore.getSession(session.id).sessionMetadata
          ?.runtimeControl as { state?: string } | undefined
      )?.state,
    ).toBe("unconfirmed");

    // The retry runs on its own: no user action, no error, and the admission
    // fence disappears as soon as the worker really exited.
    await vi.waitFor(
      () => {
        expect(
          agentRuntimeStore.getSession(session.id).sessionMetadata
            ?.runtimeControl ?? null,
        ).toBeNull();
      },
      { timeout: 5_000 },
    );
    expect(coordinator.isActive(session.id)).toBe(false);
    expect(attempts).toBeGreaterThan(1);
  });

  it("does not retry after the session moved on to a newer run", async () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    let confirmations = 0;
    const coordinator = new RunCoordinator({
      execute: vi.fn(),
      interrupt: vi.fn(async () => {
        confirmations += 1;
        throw new Error("Execution shutdown could not be confirmed.");
      }),
    });

    await expect(
      coordinator.interrupt(session.id, "User stopped run."),
    ).rejects.toThrow(/could not be confirmed/);
    // A newer owner (admission replaced the session state) makes the retry obsolete.
    await vi.waitFor(() => expect(confirmations).toBeGreaterThan(1), {
      timeout: 5_000,
    });
    const internal = coordinator as unknown as {
      owners: Map<string, unknown>;
    };
    internal.owners.delete(session.id);
    const settled = confirmations;
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(confirmations).toBe(settled);
  });
});
