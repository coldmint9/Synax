import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withWorkspaceMutation } from "../workspace-mutation.js";
import { assertSessionFileReadForWrite, clearSessionFileRead, recordSessionFileDiscovery, recordSessionFileMutation, recordSessionFileRead } from "../read-tracker.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "../tools/workspace.js";
import { invalidateSessionEnvironment } from "../session-environment.js";
import { decodeText, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "./limits.js";
import { diffStats } from "./diff-stats.js";
import { normalizeStagedOperations } from "./staged-ops.js";
import { assertGenerationAllowed } from "./permissions.js";
import type { GenerationPlan } from "./runner.js";

interface Original { content: Buffer; mode: number; stat: fs.Stats }
export interface GeneratedFile { path: string; action: "add" | "update" | "delete"; bytes: number; additions?: number; deletions?: number; movePath?: string }
export interface GenerationCommit {
  files: GeneratedFile[];
  totals: { files: number; bytes: number; additions?: number; deletions?: number };
  error?: string; rolledBack?: true; residualPaths?: string[];
}

function readOriginal(file: string): Original | undefined {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Expected a regular text file of at most 8 MB: ${file}`);
  const content = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (content.length > MAX_FILE_BYTES || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino)
    throw new Error(`File changed on disk during the transaction read: ${file}`);
  decodeText(content);
  return { content, mode: stat.mode, stat };
}

function atomicWrite(file: string, content: Buffer | string, mode?: number): void {
  const temporary = path.join(path.dirname(file), `.synax-generate-${randomUUID()}.tmp`);
  let failure: unknown;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode: mode ?? 0o666 });
    if (mode !== undefined) fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } catch (error) { failure = error; }
  try { fs.rmSync(temporary, { force: true }); } catch (error) {
    throw Object.assign(new Error(`Could not remove staging file ${temporary}`, { cause: failure ?? error }), { residualPaths: [temporary] });
  }
  if (failure) throw failure;
}

function assertOriginalCurrent(file: string, original?: Original): void {
  let current: fs.Stats | undefined;
  try { current = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!current && !original) return;
  if (!current || !original || current.size !== original.stat.size || current.mtimeMs !== original.stat.mtimeMs ||
      current.ino !== original.stat.ino || current.mode !== original.stat.mode)
    throw new Error(`File changed on disk before commit: ${file}`);
}

export async function commitGeneration(sessionId: string, plan: GenerationPlan, signal?: AbortSignal): Promise<GenerationCommit> {
  const resolved = normalizeStagedOperations(sessionId, plan.operations);
  const deletePaths = [...new Set([...plan.requiresDelete, ...resolved.filter(item => item.type === "delete").map(item => item.path)])];
  assertGenerationAllowed(sessionId, resolved.map(item => item.path), deletePaths);
  let completed: GenerationCommit | undefined;
  const transaction = () => {
    signal?.throwIfAborted();
    assertGenerationAllowed(sessionId, resolved.map(item => item.path), deletePaths);
    // Resolve again after waiting for the lock; a changed symlink must not redirect it.
    for (const item of resolved)
      if (resolveWorkspacePath(item.path, sessionId) !== item.target) throw new Error(`Path changed while waiting for the workspace: ${item.path}`);
    for (const read of plan.reads) {
      const file = resolveWorkspacePath(read.path, sessionId);
      const original = readOriginal(file);
      if (!original || original.content.length !== read.bytes || createHash("sha256").update(original.content).digest("hex") !== read.sha256)
        throw new Error(`File changed on disk during generation: ${read.path}`);
      assertSessionFileReadForWrite(sessionId, file);
      recordSessionFileRead(sessionId, file, original.content, original.stat);
    }
    const originals = new Map<string, Original | undefined>();
    let originalBytes = 0;
    const files: GeneratedFile[] = [];
    for (const item of resolved) {
      const original = readOriginal(item.target);
      originals.set(item.target, original);
      originalBytes += original?.content.length ?? 0;
      if (originalBytes > MAX_TOTAL_BYTES) throw new Error("Original files exceed the 64 MB rollback limit; split the request.");
      assertSessionFileReadForWrite(sessionId, item.target);
      // Validate all existing ancestors before the first mutation.
      for (let parent = path.dirname(item.target); ; parent = path.dirname(parent)) {
        if (fs.existsSync(parent)) { if (!fs.statSync(parent).isDirectory()) throw new Error(`Parent is not a directory: ${parent}`); break; }
        if (parent === path.dirname(parent)) break;
      }
      files.push({ path: toWorkspaceRelative(item.target, sessionId), action: item.type === "delete" ? "delete" : original ? "update" : "add",
        bytes: Buffer.byteLength(item.content ?? ""), ...diffStats(original ? decodeText(original.content) : "", item.content ?? ""),
        ...(item.movePath ? { movePath: toWorkspaceRelative(resolveWorkspacePath(item.movePath, sessionId), sessionId) } : {}),
      });
    }
    const totals = { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      ...(files.every(file => file.additions !== undefined) ? { additions: files.reduce((sum, file) => sum + file.additions!, 0), deletions: files.reduce((sum, file) => sum + file.deletions!, 0) } : {}) };
    const applied: string[] = [];
    const directories: string[] = [];
    try {
      for (const item of resolved) {
        signal?.throwIfAborted();
        assertOriginalCurrent(item.target, originals.get(item.target));
        applied.push(item.target);
        if (item.type === "write") {
          const missing: string[] = [];
          for (let parent = path.dirname(item.target); !fs.existsSync(parent); parent = path.dirname(parent)) missing.push(parent);
          for (const directory of missing.reverse()) { fs.mkdirSync(directory); directories.push(directory); }
          atomicWrite(item.target, item.content!, originals.get(item.target)?.mode);
        } else fs.rmSync(item.target, { force: true });
      }
      for (const item of resolved) {
        if (item.type === "delete") clearSessionFileRead(sessionId, item.target);
        else { recordSessionFileMutation(sessionId, item.target, item.content); recordSessionFileDiscovery(sessionId, item.target); }
      }
      invalidateSessionEnvironment(sessionId);
      return completed = { files, totals };
    } catch (error) {
      const temporaryResidues = (failure: unknown): string[] =>
        ((failure as { residualPaths?: string[] } | null)?.residualPaths ?? []).map(file => toWorkspaceRelative(file, sessionId));
      const residualPaths: string[] = temporaryResidues(error);
      for (const file of applied.reverse()) {
        try {
          const original = originals.get(file);
          if (original) { atomicWrite(file, original.content, original.mode); recordSessionFileRead(sessionId, file, original.content); }
          else { fs.rmSync(file, { force: true }); clearSessionFileRead(sessionId, file); }
        } catch (failure) { residualPaths.push(toWorkspaceRelative(file, sessionId), ...temporaryResidues(failure)); }
      }
      for (const directory of directories.reverse()) {
        try { fs.rmdirSync(directory); } catch { residualPaths.push(toWorkspaceRelative(directory, sessionId)); }
      }
      invalidateSessionEnvironment(sessionId);
      return completed = { files, totals, error: error instanceof Error ? error.message : String(error),
        ...(residualPaths.length ? { residualPaths } : { rolledBack: true as const }) };
    }
  };
  try {
    return await withWorkspaceMutation(sessionId, transaction, false, resolved.map(item => item.target), signal);
  } catch (error) {
    if (!completed) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    // Lease cleanup can fail after the callback has committed or rolled back.
    // Preserve that outcome instead of claiming that no files were changed.
    return { ...completed, error: `${completed.error ?? "Files committed"}; workspace lock cleanup failed: ${detail}`,
      ...(!completed.error ? { residualPaths: completed.files.map(file => file.path) } : {}) };
  }
}
