import fs from "node:fs";
import type { ToolCallRecord } from "./contracts.js";
import { resolveWorkspacePath } from "./tools/workspace.js";

interface ReadRecord {
  mtimeMs: number;
  size: number;
}

const sessionReads = new Map<string, Map<string, ReadRecord>>();

// Process-wide LRU budget, shared across sessions. Metadata-only records remain
// usable on the fast path; a missing snapshot never authorizes changed files.
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_CACHED_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_FILES = 256;
const snapshots = new Map<ReadRecord, Buffer>();
let cachedBytes = 0;

function dropSnapshot(record: ReadRecord | undefined): void {
  if (!record) return;
  const content = snapshots.get(record);
  if (!content) return;
  cachedBytes -= content.length;
  snapshots.delete(record);
}

function touchSnapshot(record: ReadRecord): Buffer | undefined {
  const content = snapshots.get(record);
  if (content) {
    snapshots.delete(record);
    snapshots.set(record, content);
  }
  return content;
}

function cacheSnapshot(record: ReadRecord, content: Buffer | string): void {
  const size =
    typeof content === "string"
      ? Buffer.byteLength(content, "utf8")
      : content.length;
  if (size > MAX_SNAPSHOT_BYTES || size !== record.size) return;
  while (
    cachedBytes + size > MAX_CACHED_BYTES ||
    snapshots.size >= MAX_CACHED_FILES
  ) {
    dropSnapshot(snapshots.keys().next().value);
  }
  // file.read transfers its full buffer; writes supply the text already written.
  snapshots.set(
    record,
    typeof content === "string" ? Buffer.from(content, "utf8") : content,
  );
  cachedBytes += size;
}

const BASH_READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "sed",
  "grep",
  "egrep",
  "fgrep",
]);

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Resolved path used as the tracker key, or `null` when the sandbox rejects it.
 *
 * Tool arguments may spell the same file as a workspace-relative path, an
 * absolute path or a `..`-relative alias (and the sandbox resolver also follows
 * symlinks). Keying on the raw argument string made a read and a later write of
 * the same file look unrelated, which surfaced as a bogus "was not read in this
 * session" error. A rejected path is not a tracker concern: the tool that
 * resolves it later reports the precise sandbox violation instead.
 */
function resolveTrackedPath(
  sessionId: string,
  inputPath: string,
): string | null {
  try {
    return normalizePath(resolveWorkspacePath(inputPath, sessionId));
  } catch {
    return null;
  }
}

function sessionMap(sessionId: string): Map<string, ReadRecord> {
  let reads = sessionReads.get(sessionId);
  if (!reads) {
    reads = new Map();
    sessionReads.set(sessionId, reads);
  }
  return reads;
}

function looksLikeFilePath(token: string): boolean {
  if (!token || token.startsWith("-")) return false;
  return token.includes("/") || token.includes(".") || /^[\w.-]+$/.test(token);
}

/** Paths viewed via allowed single-file bash commands (no pipes/redirects). */
export function extractBashReadPaths(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed || /[|&;<>]/.test(trimmed)) return [];

  const tokens = trimmed.split(/\s+/);
  const commandName = tokens[0]?.replace(/^.*\//, "").toLowerCase() ?? "";
  if (!BASH_READ_COMMANDS.has(commandName)) return [];

  const fileTokens: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) continue;
    if (commandName === "sed" && !looksLikeFilePath(token)) continue;
    if (looksLikeFilePath(token)) fileTokens.push(token);
  }

  if (fileTokens.length === 0) return [];
  return [fileTokens[fileTokens.length - 1]!];
}

/**
 * Reuse bytes and metadata from the actual read, never perform another read here.
 * Bash/history callers without original bytes retain the conservative stat guard.
 * A supplied Buffer is owned by the tracker and must not be mutated afterwards.
 */
export function recordSessionFileRead(
  sessionId: string,
  workspaceRelativePath: string,
  content?: Buffer | string,
  readStat?: fs.Stats,
): void {
  const filePath = resolveTrackedPath(sessionId, workspaceRelativePath);
  if (!filePath) return;
  if (!readStat && !fs.existsSync(filePath)) return;
  const stat = readStat ?? fs.statSync(filePath);
  if (!stat.isFile()) return;
  const reads = sessionMap(sessionId);
  dropSnapshot(reads.get(filePath));
  const record = { mtimeMs: stat.mtimeMs, size: stat.size };
  reads.set(filePath, record);
  if (content !== undefined) cacheSnapshot(record, content);
}

/**
 * Record the post-write state of a file the session itself just modified.
 *
 * The guard exists to stop blind overwrites of content the model never saw; a
 * successful edit or write by this same session satisfies it, so the recorded
 * mtime must advance with the write. Without this refresh every follow-up edit
 * of the same file failed with "changed on disk since last read" and forced a
 * redundant re-read.
 */
export function recordSessionFileMutation(
  sessionId: string,
  workspaceRelativePath: string,
  content?: string,
): void {
  recordSessionFileRead(sessionId, workspaceRelativePath, content);
}

/** Drop a tracked file, e.g. after the session deleted it. */
export function clearSessionFileRead(
  sessionId: string,
  workspaceRelativePath: string,
): void {
  const reads = sessionReads.get(sessionId);
  if (!reads) return;
  const filePath =
    resolveTrackedPath(sessionId, workspaceRelativePath) ??
    normalizePath(workspaceRelativePath);
  dropSnapshot(reads.get(filePath));
  reads.delete(filePath);
}

export function recordBashFileReads(
  sessionId: string,
  command: string,
  exitCode: number | null,
): void {
  if (exitCode !== 0) return;
  for (const path of extractBashReadPaths(command)) {
    try {
      recordSessionFileRead(sessionId, path);
    } catch {
      // Ignore paths outside workspace or missing files.
    }
  }
}

export function assertSessionFileReadForWrite(
  sessionId: string,
  workspaceRelativePath: string,
): void {
  const filePath = resolveTrackedPath(sessionId, workspaceRelativePath);
  if (!filePath) return;
  if (!fs.existsSync(filePath)) return;

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return;

  const record = sessionMap(sessionId).get(filePath);
  if (!record) {
    throw new Error(
      `File "${normalizePath(workspaceRelativePath)}" was not read in this session. Call file.read first.`,
    );
  }
  const snapshot = touchSnapshot(record);
  if (stat.mtimeMs === record.mtimeMs && stat.size === record.size) return;

  // Only metadata changes take this slow path. Different sizes or an evicted
  // snapshot fail closed without loading the file. No hashing is involved.
  if (stat.size === record.size && snapshot) {
    const current = fs.readFileSync(filePath);
    const afterRead = fs.statSync(filePath);
    if (
      afterRead.mtimeMs === stat.mtimeMs &&
      afterRead.size === stat.size &&
      snapshot.equals(current)
    ) {
      record.mtimeMs = stat.mtimeMs;
      return;
    }
  }
  throw new Error(
    `File "${normalizePath(workspaceRelativePath)}" changed on disk since last read. Call file.read again before editing.`,
  );
}

export function rebuildSessionFileReads(
  sessionId: string,
  toolCalls: ToolCallRecord[],
): void {
  clearSessionFileReads(sessionId);
  sessionReads.set(sessionId, new Map());

  for (const call of toolCalls) {
    if (call.status !== "completed") continue;

    if (call.toolId === "file.read") {
      const path = (call.inputRef as { path?: string } | null)?.path;
      if (path) {
        try {
          recordSessionFileRead(sessionId, path);
        } catch {
          // File may have been removed since the read.
        }
      }
      continue;
    }

    if (call.toolId === "bash") {
      const command = (call.inputRef as { command?: string } | null)?.command;
      const exitCode =
        (call.outputRef as { exitCode?: number | null } | null)?.exitCode ??
        null;
      if (command) recordBashFileReads(sessionId, command, exitCode);
      continue;
    }

    // Replay this session's own writes in order so a rebuilt tracker records the
    // post-write mtime instead of the stale one captured by an earlier read.
    if (call.toolId === "edit" || call.toolId === "file.write") {
      const path = (call.inputRef as { path?: string } | null)?.path;
      if (path) {
        try {
          recordSessionFileMutation(sessionId, path);
        } catch {
          // File may have been removed since the write.
        }
      }
      continue;
    }

    if (call.toolId === "file.delete") {
      const path = (call.inputRef as { path?: string } | null)?.path;
      if (path) clearSessionFileRead(sessionId, path);
    }
  }
}

/** @internal Test helper */
export function clearSessionFileReads(sessionId: string): void {
  for (const record of sessionReads.get(sessionId)?.values() ?? [])
    dropSnapshot(record);
  sessionReads.delete(sessionId);
}

/** @internal Test helper */
export function getSessionReadPaths(sessionId: string): string[] {
  return [...(sessionReads.get(sessionId)?.keys() ?? [])];
}
