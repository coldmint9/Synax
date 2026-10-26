import path from "node:path";
import { resolveWorkspacePath } from "../tools/workspace.js";
import { MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "./limits.js";
import type { StagedOperation } from "./runner.js";

export interface ResolvedOperation extends StagedOperation { target: string }

/** Canonical paths share one final operation, including aliases through symlinks. */
export function normalizeStagedOperations(sessionId: string, operations: StagedOperation[]): ResolvedOperation[] {
  const keyOf = (target: string) => process.platform === "win32" ? target.toLowerCase() : target;
  const final = new Map<string, ResolvedOperation>();
  for (const operation of operations) {
    const target = resolveWorkspacePath(operation.path, sessionId);
    if (operation.type === "write") {
      if (typeof operation.content !== "string" || operation.content.includes("\0")) throw new Error("Expected UTF-8 text without NUL bytes.");
      if (Buffer.byteLength(operation.content) > MAX_FILE_BYTES) throw new Error("Single file exceeds 8 MB; split the request.");
    }
    final.set(keyOf(target), { ...operation, target });
  }
  const values = [...final.values()];
  if (values.length > MAX_FILES || values.reduce((sum, item) => sum + Buffer.byteLength(item.content ?? ""), 0) > MAX_TOTAL_BYTES)
    throw new Error("Generation exceeds 120 files or 64 MB; split the request.");
  const moved = new Set<string>();
  for (const operation of values) {
    if (!operation.movePath) continue;
    const destination = keyOf(resolveWorkspacePath(operation.movePath, sessionId));
    if (operation.type !== "delete" || destination === keyOf(operation.target) || final.get(destination)?.type !== "write" || moved.has(destination))
      throw new Error("Conflicting move source or destination.");
    moved.add(destination);
  }
  for (const target of final.keys())
    for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent))
      if (final.has(parent)) throw new Error("A generated file conflicts with a parent path.");
  return values;
}
