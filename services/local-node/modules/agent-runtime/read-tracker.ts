import fs from "node:fs";
import path from "node:path";
import type { ToolCallRecord } from "./contracts.js";
import { resolveWorkspacePath } from "./tools/workspace.js";
import { parseApplyPatchEnvelope } from "./tools/patch-format.js";

interface ReadRecord {
  mtimeMs: number;
  size: number;
}

const sessionReads = new Map<string, Map<string, ReadRecord>>();
const sessionDiscoveredFiles = new Map<string, Set<string>>();

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

function discoveredFiles(sessionId: string): Set<string> {
  let files = sessionDiscoveredFiles.get(sessionId);
  if (!files) {
    files = new Set();
    sessionDiscoveredFiles.set(sessionId, files);
  }
  return files;
}

/** Record a file path returned by a successful workspace discovery tool. */
export function recordSessionFileDiscovery(
  sessionId: string,
  workspacePath: string,
): void {
  try {
    const filePath = resolveTrackedPath(sessionId, workspacePath);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile())
      return;
    discoveredFiles(sessionId).add(filePath);
  } catch {
    // Discovery is advisory bookkeeping; the originating tool owns the error.
  }
}

/** Find likely workspace files for a path the model may have guessed. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j]!;
      row[j] = a[i - 1] === b[j - 1]
        ? diagonal
        : Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + 1);
      diagonal = saved;
    }
  }
  return row[b.length]!;
}

function suggestFilePaths(
  sessionId: string,
  resolvedPath: string,
): string[] {
  const requestedName = path.basename(resolvedPath).toLowerCase();
  const candidates: Array<{ path: string; score: number }> = [];
  const root = resolveWorkspacePath(".", sessionId);
  const queue = [root];
  let visited = 0;
  const ignored = new Set([".git", "node_modules", "dist", "build", "server-dist", "dist-electron"]);

  while (queue.length > 0 && visited < 5000) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited++ >= 5000) break;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) queue.push(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const name = entry.name.toLowerCase();
      const distance = editDistance(requestedName, name);
      const sameExtension = path.extname(requestedName) === path.extname(name);
      const containsStem = name.includes(path.basename(requestedName, path.extname(requestedName)));
      if (distance <= Math.max(3, Math.floor(requestedName.length * 0.35)) || containsStem) {
        const absolute = path.join(current, entry.name);
        candidates.push({
          path: toWorkspaceRelativeForSuggestion(absolute, sessionId),
          score: distance + (sameExtension ? 0 : 4) + (containsStem ? -2 : 0),
        });
      }
    }
  }
  return [...new Map(candidates.sort((a, b) => a.score - b.score).map((item) => [item.path, item])).values()]
    .slice(0, 5)
    .map((item) => item.path);
}

function toWorkspaceRelativeForSuggestion(absPath: string, sessionId: string): string {
  const root = resolveWorkspacePath(".", sessionId);
  const relative = path.relative(root, absPath).replace(/\\/g, "/");
  return relative || ".";
}

/**
 * Confirm a path when possible, but turn guessed paths into actionable search
 * feedback instead of forcing the model through a second blind tool call.
 */
export function ensureSessionFileReadable(
  sessionId: string,
  workspacePath: string,
): void {
  const filePath = resolveTrackedPath(sessionId, workspacePath);
  if (filePath && sessionDiscoveredFiles.get(sessionId)?.has(filePath)) return;
  if (filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        recordSessionFileDiscovery(sessionId, filePath);
        return;
      }
    } catch {
      // Fall through to the bounded suggestion scan below.
    }
    const suggestions = suggestFilePaths(sessionId, filePath);
    const hint = suggestions.length
      ? ` Possible matches: ${suggestions.join(", ")}.`
      : " No close workspace matches were found.";
    throw new Error(
      `File not found: "${normalizePath(workspacePath)}".${hint} Use one of the suggested paths or search the workspace.`,
    );
  }
  throw new Error(`File path "${normalizePath(workspacePath)}" is outside the session workspace.`);
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
  sessionDiscoveredFiles.get(sessionId)?.delete(filePath);
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

/**
 * Ensure the tracker holds a current read record for a file a write tool is
 * about to overwrite.
 *
 * A missing record no longer fails the call: write tools absorb the requirement
 * by reading the file themselves and registering that read, so overwriting an
 * unread-but-existing target costs no file.read round trip. Returns `true` when
 * that implicit read happened, letting the caller tell the model it overwrote
 * content this session never saw.
 *
 * A recorded read whose file changed on disk afterwards still throws: that is an
 * external edit the write would silently clobber, which is a different failure
 * from missing bookkeeping.
 */
export function assertSessionFileReadForWrite(
  sessionId: string,
  workspaceRelativePath: string,
): boolean {
  const filePath = resolveTrackedPath(sessionId, workspaceRelativePath);
  if (!filePath) return false;
  if (!fs.existsSync(filePath)) return false;

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return false;

  const record = sessionMap(sessionId).get(filePath);
  if (!record) {
    // The pre-read stat is kept on purpose: it becomes the snapshot metadata, so
    // a file mutated during this read is still caught as "changed on disk"
    // instead of being recorded as freshly read.
    let content: Buffer | undefined;
    try {
      content = fs.readFileSync(filePath);
    } catch {
      // Unreadable bytes are not fatal here; the write itself reports the real
      // failure and the metadata-only record stays conservative.
    }
    recordSessionFileRead(sessionId, workspaceRelativePath, content, stat);
    return true;
  }
  const snapshot = touchSnapshot(record);
  if (stat.mtimeMs === record.mtimeMs && stat.size === record.size) return false;

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
      return false;
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

    if (call.toolId === "file.list") {
      const items = (call.outputRef as {
        items?: Array<{ path?: string; kind?: string }>;
      } | null)?.items;
      for (const item of items ?? []) {
        if (item.kind === "file" && item.path) {
          recordSessionFileDiscovery(sessionId, item.path);
        }
      }
      continue;
    }

    if (call.toolId === "rg" || call.toolId === "grep.search") {
      const hits = (call.outputRef as {
        hits?: Array<{ path?: string }>;
      } | null)?.hits;
      for (const hit of hits ?? []) {
        if (hit.path) recordSessionFileDiscovery(sessionId, hit.path);
      }
      continue;
    }

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

    if (call.toolId === "file.generate") {
      const files = (call.outputRef as { files?: Array<{ path: string; action: string }> } | null)?.files;
      for (const file of files ?? []) {
        try {
          if (file.action === "delete") clearSessionFileRead(sessionId, file.path);
          else { recordSessionFileMutation(sessionId, file.path); recordSessionFileDiscovery(sessionId, file.path); }
        } catch { /* Files may have been removed since generation. */ }
      }
      continue;
    }

    if (call.toolId === "file.delete") {
      const path = (call.inputRef as { path?: string } | null)?.path;
      if (path) clearSessionFileRead(sessionId, path);
      continue;
    }

    if (call.toolId === "file.patch") {
      const patch = (call.inputRef as { patch?: string } | null)?.patch;
      if (patch) {
        try {
          for (const hunk of parseApplyPatchEnvelope(patch)) {
            if (hunk.type === "delete") {
              clearSessionFileRead(sessionId, hunk.path);
              continue;
            }
            const moves = hunk.type === "update" && hunk.movePath;
            if (moves) clearSessionFileRead(sessionId, hunk.path);
            recordSessionFileMutation(sessionId, moves ? hunk.movePath! : hunk.path);
          }
        } catch {
          // Failed or unparseable historical patch: nothing was written.
        }
      }
    }
  }
}

/** @internal Test helper */
export function clearSessionFileReads(sessionId: string): void {
  for (const record of sessionReads.get(sessionId)?.values() ?? [])
    dropSnapshot(record);
  sessionReads.delete(sessionId);
  sessionDiscoveredFiles.delete(sessionId);
}

/** @internal Test helper */
export function getSessionReadPaths(sessionId: string): string[] {
  return [...(sessionReads.get(sessionId)?.keys() ?? [])];
}
