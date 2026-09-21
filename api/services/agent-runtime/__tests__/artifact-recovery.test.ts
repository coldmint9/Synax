vi.mock("../artifact-jobs.js", () => ({
  processArtifactJobs: vi.fn(async () => {}),
}));
import { afterEach, it, expect, vi } from "vitest";
import { startArtifactRecovery } from "../artifact-recovery.js";
import { resumeArtifactBuilds } from "../artifacts/publisher.js";
vi.mock("../artifacts/publisher.js", () => ({
  resumeArtifactBuilds: vi.fn(async () => 0),
}));
vi.mock("../artifact-integration.js", () => ({
  drainArtifactPublications: vi.fn(),
}));
vi.mock("../../../db/index.js", () => ({
  getRawSqlite: () => ({
    prepare: () => ({ all: () => [], run: () => ({ changes: 0 }) }),
  }),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("keeps retrying after startup so leases expiring after a fast restart recover", async () => {
  vi.useFakeTimers();
  const error = vi.fn();
  const stop = startArtifactRecovery(error);
  await vi.advanceTimersByTimeAsync(16000);
  expect(resumeArtifactBuilds).toHaveBeenCalledTimes(4);
  stop();
  await vi.advanceTimersByTimeAsync(10000);
  expect(resumeArtifactBuilds).toHaveBeenCalledTimes(4);
  expect(error).not.toHaveBeenCalled();
});
