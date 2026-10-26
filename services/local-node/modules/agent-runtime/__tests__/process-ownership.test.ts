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
import { runWithExecutionContext } from '../../../infrastructure/runtime/execution-context.js';

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

  it('registers the final PID once and carries the launching execution identity', async () => {
    const owner = { sessionId: 's', runId: 'r', epoch: 'generation', hostId: 'host' };
    const ticket = runWithExecutionContext(owner, () => {
      const ticket = prepareOwnedProcess('test', true);
      recordOwnedPid(ticket.id, 123);
      return ticket;
    });
    await waitForAuthoritativeLease(ticket.id);
    expect(controlCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      operation: 'lease_open', payload: expect.objectContaining({ pid: 123, executionLease: owner }),
    }));
    releaseOwnedProcess(ticket.id);
    await waitForAuthoritativeLease(ticket.id);
  });

  it('keeps the process gate closed until an update arriving during a write is durable', async () => {
    let first!: () => void; let second!: () => void;
    const gate1 = new Promise<void>(resolve => { first = resolve; });
    const gate2 = new Promise<void>(resolve => { second = resolve; });
    controlCommand.mockImplementationOnce(() => gate1).mockImplementationOnce(() => gate2);
    const ticket = prepareOwnedProcess('test', true, { sessionId: 's' });
    await vi.waitFor(() => expect(controlCommand).toHaveBeenCalledOnce());
    recordOwnedPid(ticket.id, 456);
    let acknowledged = false;
    const waiting = waitForAuthoritativeLease(ticket.id).then(() => { acknowledged = true; });
    first();
    await vi.waitFor(() => expect(controlCommand).toHaveBeenCalledTimes(2));
    expect(acknowledged).toBe(false);
    expect(controlCommand.mock.calls[0][0].requestId).not.toBe(controlCommand.mock.calls[1][0].requestId);
    second(); await waiting;
    releaseOwnedProcess(ticket.id); await waitForAuthoritativeLease(ticket.id);
  });
});
