import { randomUUID } from "node:crypto";

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

/** Opaque IDs must remain unique across the API process and all session workers. */
export function makeRuntimeId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

/** Kept for fixture callers; UUIDs have no process-local sequence to reset. */
export function resetRuntimeIdsForTests(): void {}
