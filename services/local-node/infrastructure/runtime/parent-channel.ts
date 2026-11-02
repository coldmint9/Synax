/**
 * The desktop shell parents this process (Electron `utilityProcess` in a
 * packaged app, an IPC child process in development). Everything it may send or
 * receive crosses this one seam, so callers never touch the transport.
 */
type ParentPortEvent = { data: unknown };
const parentPort = (
  process as typeof process & {
    parentPort?: {
      postMessage(message: unknown): void;
      on(event: "message", listener: (event: ParentPortEvent) => void): void;
    };
  }
).parentPort;

export function parentChannelAvailable(): boolean {
  return Boolean(parentPort) || typeof process.send === "function";
}

export function onParentMessage(handler: (message: unknown) => void): void {
  // A standalone server (web or CLI) has no parent; both registrations are
  // inert there and the handler simply never runs.
  process.on("message", handler);
  parentPort?.on("message", (event) => handler(event.data));
}

/** Returns false when nothing is listening, so callers can skip formatting. */
export function postParentMessage(message: unknown): boolean {
  if (parentPort) {
    try {
      parentPort.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }
  if (typeof process.send !== "function" || !process.connected) return false;
  try {
    process.send(message);
    return true;
  } catch {
    return false;
  }
}
