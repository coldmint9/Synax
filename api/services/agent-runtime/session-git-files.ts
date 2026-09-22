import fsp from "node:fs/promises";
import { logger } from "../../lib/logger.js";
import {
  invalidateSessionEnvironment,
  resolveSafeFile,
  resolveSessionRepository,
} from "./session-environment.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  AgentNotFoundError,
  AgentRuntimeError,
  AgentValidationError,
} from "./runtime-errors.js";
import { runGit } from "./session-git-commit.js";

export interface SessionFileRestoreInput {
  rootId?: string;
  /** Workspace-relative path, as reported by the environment change list. */
  path: string;
}

export interface SessionFileRestoreResult {
  rootId: string;
  path: string;
  /**
   * `true` when the entry was untracked, so reverting meant deleting the file
   * from disk instead of checking out its HEAD state.
   */
  deleted: boolean;
}

interface StatusEntry {
  xy: string;
  path: string;
  /** Original path of a staged rename/copy; `null` otherwise. */
  originalPath: string | null;
}

/**
 * Parse `git status --porcelain=v1 -uall -z`. Rename/copy records place the
 * destination first and keep the original path in the following record.
 */
export function parseStatusEntries(output: string): StatusEntry[] {
  const records = output.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const entryPath = record.slice(3);
    let originalPath: string | null = null;
    if (xy.includes("R") || xy.includes("C")) {
      originalPath = records[index + 1] || null;
      index += 1;
    }
    entries.push({ xy, path: entryPath, originalPath });
  }
  return entries;
}

function getSession(sessionId: string) {
  try {
    return agentRuntimeStore.getSession(sessionId);
  } catch {
    throw new AgentNotFoundError(sessionId);
  }
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    return (await fsp.stat(absolutePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Revert one workspace file to its HEAD state, per the Git changes list.
 *
 * Tracked entries are restored from `HEAD` (index and working tree); entries
 * that only exist staged (new files, rename destinations) are unstaged and
 * removed. Untracked entries are deleted outright — there is no committed
 * state to go back to. Only paths currently listed by `git status` qualify,
 * so arbitrary workspace paths cannot be wiped through this route.
 */
export async function restoreSessionFile(
  sessionId: string,
  input: SessionFileRestoreInput,
): Promise<SessionFileRestoreResult> {
  const session = getSession(sessionId);
  if (session.activeRunId) {
    throw new AgentRuntimeError(
      "The session is still running. Wait for it to finish before reverting files.",
      "GIT_SESSION_BUSY",
      409,
    );
  }
  const target = input.path?.trim();
  if (!target) throw new AgentValidationError("File path is required.");

  const root = resolveSessionRepository(sessionId, session.projectId, input.rootId, true);
  const workspacePath = root.path;
  // Rejects absolute paths, traversals and symlink escapes before any git call.
  resolveSafeFile(workspacePath, target);

  const status = await runGit(workspacePath, [
    "status",
    "--porcelain=v1",
    "-uall",
    "-z",
  ]);
  const entries = parseStatusEntries(status.stdout);
  const entry = entries.find(
    (candidate) => candidate.path === target || candidate.originalPath === target,
  );
  if (!entry) {
    throw new AgentValidationError(
      "The file has no uncommitted changes to revert.",
    );
  }

  const untracked = entry.xy === "??";
  const involvedPaths = [entry.path, entry.originalPath].filter(
    (path): path is string => Boolean(path),
  );

  let deleted = false;
  if (untracked) {
    const absolute = resolveSafeFile(workspacePath, entry.path);
    await fsp.rm(absolute, { force: true });
    deleted = true;
  } else {
    // Restore every involved path that HEAD knows; renames restore the source
    // and drop the destination. Paths absent from HEAD only exist staged.
    const inHead: string[] = [];
    for (const candidate of involvedPaths) {
      const probe = await runGit(
        workspacePath,
        ["cat-file", "-e", `HEAD:${candidate}`],
        true,
      );
      if (probe.ok) inHead.push(candidate);
    }
    if (inHead.length > 0) {
      await runGit(workspacePath, ["checkout", "HEAD", "--", ...inHead]);
    }
    for (const candidate of involvedPaths) {
      if (inHead.includes(candidate)) continue;
      await runGit(workspacePath, ["rm", "-f", "--cached", "--", candidate]);
      const absolute = resolveSafeFile(workspacePath, candidate);
      if (await fileExists(absolute)) {
        await fsp.rm(absolute, { force: true });
        deleted = true;
      }
    }
  }

  invalidateSessionEnvironment(sessionId);
  logger.info(
    { sessionId, rootId: root.id, path: entry.path, deleted },
    untracked
      ? "[git-files] deleted untracked file to revert it"
      : "[git-files] reverted file to HEAD state",
  );

  return { rootId: root.id, path: entry.path, deleted };
}
