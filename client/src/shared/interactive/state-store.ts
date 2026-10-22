/**
 * Host-side snapshot store for `window.openai.widgetState`.
 *
 * A sandboxed frame runs in an opaque origin, so localStorage and friends throw
 * there. The host keeps the snapshot instead, which lets a preview restore its
 * own interaction state after a remount, a tab switch or a page reload.
 */
const PREFIX = "synax:interactive-state:";
const MAX_BYTES = 16 * 1024;
const memory = new Map<string, unknown>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readInteractiveState(key: string): unknown {
  if (memory.has(key)) return memory.get(key);
  try {
    const raw = storage()?.getItem(PREFIX + key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    memory.set(key, value);
    return value;
  } catch {
    return undefined;
  }
}

export function writeInteractiveState(key: string, value: unknown): void {
  memory.set(key, value);
  try {
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).length > MAX_BYTES) return;
    storage()?.setItem(PREFIX + key, json);
  } catch {
    // A snapshot is a convenience, never a correctness requirement.
  }
}

export function clearInteractiveState(key: string): void {
  memory.delete(key);
  try {
    storage()?.removeItem(PREFIX + key);
  } catch {
    // Ignore unavailable storage.
  }
}
