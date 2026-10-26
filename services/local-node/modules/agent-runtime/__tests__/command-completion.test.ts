import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), error: vi.fn(), warn: vi.fn() }));
vi.mock("../owned-process.js", () => ({ spawnOwnedProcess: mocks.spawn }));
vi.mock("../../../infrastructure/runtime/logger.js", () => ({ logger: { error: mocks.error, warn: mocks.warn } }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function command() {
  const cleanup = deferred();
  const reaped = deferred();
  const child = Object.assign(new EventEmitter(), {
    pid: 123456, ownedProcessId: "fixture", stdout: new PassThrough(), stderr: new PassThrough(),
    ownedProcessClosed: cleanup.promise, ownedProcessReaped: reaped.promise, kill: vi.fn(),
  });
  mocks.spawn.mockReturnValue(child);
  return { child, cleanup, reaped, finish() { cleanup.resolve(); reaped.resolve(); } };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("returns complete output on close without waiting for the cleanup scan", async () => {
  const fixture = command();
  const { runCommand, terminateOwnedCommands } = await import("../tools/exec-async.js");
  let delivered = false;
  const result = runCommand("fixture", []).then(value => { delivered = true; return value; });
  fixture.child.stdout.emit("data", Buffer.from("first"));
  fixture.child.emit("exit", 7, null);
  await Promise.resolve();
  expect(delivered).toBe(false);
  fixture.child.stdout.emit("data", Buffer.from(" last"));
  fixture.child.emit("close", 7, null);
  expect(await result).toMatchObject({ status: 7, stdout: "first last", timedOut: false });

  let stopped = false;
  const stop = terminateOwnedCommands().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  // A bounded cleanup wait timing out must not release the actual ownership.
  fixture.cleanup.reject(new Error("inspection timeout"));
  await Promise.resolve();
  expect(stopped).toBe(false);
  fixture.reaped.resolve();
  await stop;
  expect(mocks.warn).toHaveBeenCalledOnce();
  expect(mocks.error).not.toHaveBeenCalled();
});

it.each(["explicit", "abort", "timeout", "signal", "shutdown", "output-limit"])(
  "keeps the cleanup barrier for %s", async reason => {
    vi.useFakeTimers();
    const fixture = command();
    const { runCommand, terminateOwnedCommands } = await import("../tools/exec-async.js");
    const controller = new AbortController();
    let delivered = false;
    const result = runCommand("fixture", [], {
      waitForCleanup: reason === "explicit", signal: controller.signal,
      timeoutMs: reason === "timeout" ? 100 : undefined,
      onStdout: reason === "output-limit" ? () => false : undefined,
    }).then(value => { delivered = true; return value; });
    if (reason === "abort") controller.abort();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(100);
    if (reason === "output-limit") fixture.child.stdout.emit("data", Buffer.from("enough"));
    const stop = reason === "shutdown" ? terminateOwnedCommands() : undefined;
    fixture.child.emit("close", reason === "signal" ? null : 0, reason === "signal" ? "SIGTERM" : null);
    await Promise.resolve();
    expect(delivered).toBe(false);
    fixture.finish();
    const value = await result;
    await stop;
    expect(value.timedOut).toBe(reason === "timeout");
    if (reason === "abort") expect(value.error?.code).toBe("ABORT_ERR");
  },
);

it("logs failed background cleanup and makes shutdown report the failure", async () => {
  const fixture = command();
  const { runCommand, terminateOwnedCommands } = await import("../tools/exec-async.js");
  const result = runCommand("fixture", []);
  fixture.child.emit("close", 0, null);
  expect((await result).status).toBe(0);
  const error = new Error("guardian disconnected");
  fixture.cleanup.reject(error);
  fixture.reaped.reject(error);
  await expect(terminateOwnedCommands()).rejects.toThrow("guardian disconnected");
  expect(mocks.error).toHaveBeenCalledOnce();
});

it("reports a strict cleanup timeout without dropping the eventual cleanup barrier", async () => {
  const fixture = command();
  const { runCommand, terminateOwnedCommands } = await import("../tools/exec-async.js");
  const result = runCommand("fixture", [], { waitForCleanup: true });
  fixture.child.emit("close", 0, null);
  fixture.cleanup.reject(new Error("inspection timeout"));
  expect((await result).error?.code).toBe("PROCESS_CLEANUP_FAILED");
  let stopped = false;
  const stop = terminateOwnedCommands().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  fixture.reaped.resolve();
  await stop;
});
