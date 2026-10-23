import { AgentRuntimeError } from "./runtime-errors.js";

// One API host owns worktree allocation. Rust independently serializes and
// receipts the durable copy. Do not create two worktrees before reaching it.
const pending = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
export function singleForkRequest<T>(key: string, fingerprint: string, action: () => Promise<T>): Promise<T> {
  const previous = pending.get(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      return Promise.reject(new AgentRuntimeError("Fork request content changed.", "REQUEST_CONFLICT", 409));
    return previous.result as Promise<T>;
  }
  if (pending.size >= 32) return Promise.reject(new AgentRuntimeError("Conversation copy queue is full.", "FORK_BUSY", 429));
  const result = Promise.resolve().then(action).finally(() => {
    if (pending.get(key)?.result === result) pending.delete(key);
  });
  pending.set(key, { fingerprint, result });
  return result;
}
