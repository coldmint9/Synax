import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { controlCommand } = vi.hoisted(() => ({
  controlCommand: vi.fn(),
}));

vi.mock("../sidecar/runtime-facade.js", () => ({
  runtimeFacade: { controlCommand },
}));

import {
  prepareOwnedProcess,
  recordOwnedPid,
  releaseOwnedProcess,
  waitForAuthoritativeLease,
} from "../process-ownership.js";

describe("authoritative process lease mirroring", () => {
  beforeEach(() => {
    vi.stubEnv("SYNAX_RUNTIME_SIDECAR_STREAM", "authoritative");
    controlCommand.mockReset();
    controlCommand.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serializes and coalesces rapid updates for one lease", async () => {
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    controlCommand.mockImplementationOnce(async () => {
      await firstWrite;
      return {};
    });

    const ticket = prepareOwnedProcess("test", true, { sessionId: "s", background: true });
    recordOwnedPid(ticket.id, 100);
    recordOwnedPid(ticket.id, 101);
    releaseOwnedProcess(ticket.id);
    releaseFirst();
    await waitForAuthoritativeLease(ticket.id);

    expect(controlCommand.mock.calls.length).toBeLessThan(4);
    expect(controlCommand.mock.calls.at(-1)?.[0]).toMatchObject({
      operation: "lease_close",
      payload: { leaseId: ticket.id },
    });
  });
});
