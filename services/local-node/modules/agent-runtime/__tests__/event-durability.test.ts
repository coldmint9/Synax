import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldPersistRuntimeEvent } from "../event-durability.js";

afterEach(() => vi.unstubAllEnvs());

describe("runtime event durability", () => {
  it("keeps streamed deltas durable in the SQLite fallback", () => {
    expect(
      shouldPersistRuntimeEvent("message_delta", {
        versioned: false,
        boundaryOnly: false,
      }),
    ).toBe(true);
  });

  it("moves replayable deltas out of the event table when file replay is active", () => {
    vi.stubEnv("SYNAX_STORAGE_OWNER_ENDPOINT", "/tmp/synax-storage.sock");
    expect(
      shouldPersistRuntimeEvent("message_delta", {
        versioned: false,
        boundaryOnly: false,
      }),
    ).toBe(false);
    expect(
      shouldPersistRuntimeEvent("task_state_updated", {
        versioned: false,
        boundaryOnly: false,
      }),
    ).toBe(true);
  });

  it("never removes events from checkpoint or diagnostic storage", () => {
    vi.stubEnv("SYNAX_STORAGE_OWNER_ENDPOINT", "/tmp/synax-storage.sock");
    expect(
      shouldPersistRuntimeEvent("message_delta", {
        versioned: true,
        boundaryOnly: false,
      }),
    ).toBe(true);
    expect(
      shouldPersistRuntimeEvent("progress_updated", {
        versioned: false,
        boundaryOnly: true,
      }),
    ).toBe(true);
  });
});
