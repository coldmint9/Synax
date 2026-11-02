import { expect, it } from "vitest";
import { resolveLiveLoop } from "../backends/rust-native-backend.js";

const run = (id: string, metadata: Record<string, unknown> = {}) => ({ id, metadata });

it("keeps the loop this process owns when the run document lost its handle", () => {
  expect(resolveLiveLoop({ loopId: "aloop_live", runId: "run-1" }, run("run-1"))).toBe("aloop_live");
});

it("falls back to the persisted handle when this process owns no loop for the run", () => {
  expect(resolveLiveLoop(undefined, run("run-1", { rustLoopId: "aloop_persisted" }))).toBe("aloop_persisted");
});

it("never resumes another run's loop", () => {
  expect(resolveLiveLoop({ loopId: "aloop_previous", runId: "run-0" }, run("run-1", { rustLoopId: "aloop_persisted" })))
    .toBe("aloop_persisted");
  expect(resolveLiveLoop({ loopId: "aloop_previous", runId: "run-0" }, run("run-1"))).toBeUndefined();
});

it("reports no execution when neither the process nor the document names a loop", () => {
  expect(resolveLiveLoop(undefined, run("run-1", { rustLoopId: 42 }))).toBeUndefined();
});
