import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_REPLAY_BASE, fileBackedReplayEnabled } from "../replay-storage.js";

afterEach(() => vi.unstubAllEnvs());

describe("replay storage mode", () => {
  it("uses the file cursor range only when the storage owner is available", () => {
    expect(FILE_REPLAY_BASE).toBe(2 ** 40);
    expect(fileBackedReplayEnabled()).toBe(false);

    vi.stubEnv("SYNAX_STORAGE_OWNER_ENDPOINT", "/tmp/synax-storage.sock");
    expect(fileBackedReplayEnabled()).toBe(true);
  });

  it("supports a controlled SQLite fallback for migration and tests", () => {
    vi.stubEnv("SYNAX_STORAGE_OWNER_ENDPOINT", "/tmp/synax-storage.sock");
    vi.stubEnv("SYNAX_DISABLE_FILE_REPLAY", "1");
    expect(fileBackedReplayEnabled()).toBe(false);
  });
});
