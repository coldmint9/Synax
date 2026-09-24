import { expect, it, vi } from "vitest";
import { observationLifetime } from "../observation-lifetime.js";
it("does not lose cancellation before awaiting a snapshot", async () => {
  const request = new AbortController(), stream = { onAbort: vi.fn() };
  const lifetime = observationLifetime(request.signal, stream);
  request.abort();
  await expect(lifetime.ended).resolves.toBeUndefined();
  expect(lifetime.signal.aborted).toBe(true);
  lifetime.dispose();
});
it("handles already aborted requests and direct reader cancellation", async () => {
  const request = new AbortController(); request.abort();
  const stream = { onAbort: vi.fn() };
  const initial = observationLifetime(request.signal, stream);
  await expect(initial.ended).resolves.toBeUndefined();
  const next = observationLifetime(new AbortController().signal, stream);
  stream.onAbort.mock.calls.at(-1)![0]();
  await expect(next.ended).resolves.toBeUndefined();
  expect(next.signal.aborted).toBe(true);
});
