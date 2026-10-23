import { withWorkspaceMutation } from "./workspace-mutation.js";
import fs from "node:fs";
import { openSystemTerminal } from "../../infrastructure/file-openers/index.js";
import path from "node:path";
import { agentRuntimeStore } from "./session-store.js";
import { resolveSessionWorkspaceRoots } from "./tools/workspace.js";
import {
  canonicalWorkspaceDirectory,
  workspaceRootHostPath,
  type ProjectWorkspaceRoot,
} from "../project-workspace.js";
import { AgentNotFoundError, AgentValidationError } from "./runtime-errors.js";
import type { AgentSessionStatus, ToolCallRecord } from "./contracts.js";
import { detectMediaType } from "./media-assets.js";
import { assertRelativePath, resolveSafeFile } from "./workspace-paths.js";
import { readWorkspacePreview, previewText } from './workspace-preview.js';
import {
  invalidateWorkspaceGitForSession,
  readWorkspaceGit,
} from "./workspace-git-changes.js";
import { invalidateSessionEnvironmentCards } from "./session-environment-cards.js";

/**
 * Workspace file access for the session environment APIs.
 *
 * The environment snapshot itself is gone: Git facts live in
 * `workspace-git-changes.ts` (workspace scope) and the conversation cards live
 * in `session-environment-cards.ts` (session scope). What remains here is the
 * file/media surface plus the single invalidation entry point every mutation
 * path already calls.
 */

export type {
  EnvironmentChangeStatus,
  WorkspaceGitFile as SessionEnvironmentFile,
} from "./workspace-git-changes.js";
export type {
  SessionEnvironmentInputSource,
  SessionEnvironmentSubagent,
} from "./session-environment-cards.js";
export { resolveSafeFile };

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024;

/** An explicit member never falls back to the primary repository. */
export function resolveSessionRepository(
  sessionId: string,
  projectId: string,
  rootId?: string,
  requireSelection = false,
): ProjectWorkspaceRoot {
  const roots = resolveSessionWorkspaceRoots(sessionId, projectId);
  if (requireSelection && roots.length > 1 && !rootId)
    throw new AgentValidationError(
      "Select a workspace project before committing.",
    );
  const root = rootId
    ? roots.find((item) => item.id === rootId)
    : roots.find((item) => item.role === "primary");
  if (!root)
    throw new AgentValidationError(
      "The selected project is not in this workspace.",
    );
  try {
    return {
      ...root,
      path: canonicalWorkspaceDirectory(workspaceRootHostPath(root)),
      status: "available",
    };
  } catch {
    throw new AgentValidationError(
      `Project directory is unavailable: ${root.name}`,
    );
  }
}

/**
 * Resolve a relative file reference to the repository that actually owns it.
 * Transcript links do not always carry a root id, while a session may contain
 * several repositories with the same relative path.
 */
function resolveSessionFileRepository(
  sessionId: string,
  projectId: string,
  relativePath: string,
  rootId?: string,
): ProjectWorkspaceRoot {
  if (rootId) return resolveSessionRepository(sessionId, projectId, rootId);

  const cleanPath = assertRelativePath(relativePath);
  const roots = resolveSessionWorkspaceRoots(sessionId, projectId);
  const orderedRoots = [...roots].sort(
    (a, b) => Number(b.role === "primary") - Number(a.role === "primary"),
  );

  for (const root of orderedRoots) {
    try {
      const workspacePath = canonicalWorkspaceDirectory(workspaceRootHostPath(root));
      const absolutePath = resolveSafeFile(workspacePath, cleanPath);
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        return { ...root, path: workspacePath, status: "available" };
      }
    } catch {
      // An unavailable or invalid candidate should not prevent another root
      // from resolving the same relative transcript reference.
    }
  }

  return resolveSessionRepository(sessionId, projectId);
}

export interface SessionEnvironmentFileView {
  sessionId: string;
  path: string;
  kind: "diff" | "input";
  content: string;
  truncated: boolean;
}

export interface SessionEnvironmentFileMedia {
  sessionId: string;
  path: string;
  mediaType: string;
  bytes: Buffer;
}

function getSession(sessionId: string) {
  try {
    return agentRuntimeStore.getSession(sessionId);
  } catch {
    throw new AgentNotFoundError(sessionId);
  }
}

/**
 * Drop every cached environment read for a session.
 *
 * Mutating callers (write tools, commits, restores, branch switches, archive
 * and project edits) only know the session id, so this fans out to the
 * workspace-scoped Git cache and the session-scoped cards.
 */
export function invalidateSessionEnvironment(sessionId: string): void {
  invalidateSessionEnvironmentCards(sessionId);
  invalidateWorkspaceGitForSession(sessionId);
}

export function getSessionInputSourceContentFromRecord(call: ToolCallRecord) {
  if (call.status !== "completed" || call.mutability !== "read") {
    throw new AgentValidationError(
      "Only completed input reads can be previewed.",
    );
  }
  const output = call.outputRef ?? call.outputSummary;
  const content =
    typeof output === "string"
      ? output
      : output == null
        ? ""
        : JSON.stringify(output, null, 2);
  const bytes = Buffer.from(content, "utf8");
  return {
    content: bytes.subarray(0, MAX_FILE_BYTES).toString("utf8"),
    truncated: bytes.length > MAX_FILE_BYTES,
  };
}

export async function openSessionFileInSystemTerminal(
  sessionId: string,
  relativePath: string,
  rootId?: string,
): Promise<void> {
  const session = getSession(sessionId);
  const workspacePath = resolveSessionRepository(sessionId, session.projectId, rootId, true).path;
  const absolute = resolveSafeFile(workspacePath, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new AgentValidationError("File not found in the workspace.");
  }
  await openSystemTerminal(path.dirname(absolute));
}

const FILE_MUTATION_BLOCKED_STATUSES = new Set<AgentSessionStatus>([
  "queued",
  "running",
  "stopping",
  "waiting_permission",
  "waiting_input",
]);

function assertInteractiveFileMutationAllowed(sessionId: string): void {
  const active = agentRuntimeStore.listSessionTree(sessionId).some((session) =>
    FILE_MUTATION_BLOCKED_STATUSES.has(session.status),
  );
  if (active) {
    throw new AgentValidationError(
      "File rename/delete is unavailable while this session's agent is running.",
    );
  }
}

function assertExistingMenuFile(workspacePath: string, relativePath: string): string {
  const absolute = resolveSafeFile(workspacePath, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new AgentValidationError(`File not found: ${relativePath}`);
  }
  if (fs.lstatSync(absolute).isSymbolicLink()) {
    throw new AgentValidationError("Symbolic-link files cannot be modified from the workspace menu.");
  }
  return absolute;
}

function assertSafeFileName(name: string): string {
  const clean = name.trim();
  if (!clean || clean === "." || clean === ".." || clean.includes("/") || clean.includes("\\") || clean.includes("\0") || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new AgentValidationError("A file name must be a single safe path segment.");
  }
  return clean;
}

export async function renameSessionEnvironmentFile(
  sessionId: string,
  relativePath: string,
  newName: string,
  rootId?: string,
): Promise<{ sessionId: string; path: string; previousPath: string }> {
  assertInteractiveFileMutationAllowed(sessionId);
  const session = agentRuntimeStore.getSession(sessionId);
  const workspacePath = resolveSessionRepository(sessionId, session.projectId, rootId, true).path;
  const cleanPath = assertRelativePath(relativePath);
  if (cleanPath.split("/").includes(".git")) throw new AgentValidationError("Git metadata cannot be renamed.");
  const safeName = assertSafeFileName(newName);
  const source = assertExistingMenuFile(workspacePath, cleanPath);
  const nextPath = path.posix.join(path.posix.dirname(cleanPath), safeName);
  if (nextPath === cleanPath) return { sessionId, path: cleanPath, previousPath: cleanPath };
  const target = resolveSafeFile(workspacePath, nextPath);
  if (fs.existsSync(target)) throw new AgentValidationError(`A file already exists at: ${nextPath}`);
  await withWorkspaceMutation(
    sessionId,
    () => {
      assertInteractiveFileMutationAllowed(sessionId);
      assertExistingMenuFile(workspacePath, cleanPath);
      fs.linkSync(source, target); // EEXIST fails instead of replacing a file created after validation.
      try { fs.unlinkSync(source); }
      catch (error) { fs.unlinkSync(target); throw error; }
    },
    true,
    [source, target],
  );
  invalidateSessionEnvironment(sessionId);
  return { sessionId, path: nextPath, previousPath: cleanPath };
}

export async function trashSessionEnvironmentFile(
  sessionId: string,
  relativePath: string,
  rootId?: string,
): Promise<{ sessionId: string; path: string; trashed: true }> {
  assertInteractiveFileMutationAllowed(sessionId);
  const session = agentRuntimeStore.getSession(sessionId);
  const workspacePath = resolveSessionRepository(sessionId, session.projectId, rootId, true).path;
  const cleanPath = assertRelativePath(relativePath);
  if (cleanPath.split("/").includes(".git")) throw new AgentValidationError("Git metadata cannot be trashed.");
  const target = assertExistingMenuFile(workspacePath, cleanPath);
  await withWorkspaceMutation(sessionId, async () => {
    assertInteractiveFileMutationAllowed(sessionId);
    const { default: trash } = await import("trash");
    assertExistingMenuFile(workspacePath, cleanPath);
    await trash(target, { glob: false });
  }, true, [target]);
  invalidateSessionEnvironment(sessionId);
  return { sessionId, path: cleanPath, trashed: true };
}

export async function saveSessionEnvironmentFile(
  sessionId: string,
  relativePath: string,
  content: string,
  rootId?: string,
): Promise<{ sessionId: string; path: string; bytes: number }> {
  const session = getSession(sessionId);
  const workspacePath = resolveSessionRepository(
    sessionId,
    session.projectId,
    rootId,
  ).path;
  const cleanPath = assertRelativePath(relativePath);
  const absolutePath = resolveSafeFile(workspacePath, cleanPath);
  if (!fs.existsSync(absolutePath)) {
    throw new AgentValidationError(`File not found: ${cleanPath}`);
  }
  if (!fs.statSync(absolutePath).isFile()) {
    throw new AgentValidationError(`Not a file: ${cleanPath}`);
  }
  await withWorkspaceMutation(
    sessionId,
    () => fs.writeFileSync(absolutePath, content, "utf8"),
    true,
    [absolutePath],
  );
  return {
    sessionId,
    path: cleanPath,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

export async function getSessionEnvironmentFileMedia(
  sessionId: string,
  relativePath: string,
  rootId?: string,
): Promise<SessionEnvironmentFileMedia> {
  const session = getSession(sessionId);
  const cleanPath = assertRelativePath(relativePath);
  const workspacePath = resolveSessionFileRepository(
    sessionId,
    session.projectId,
    cleanPath,
    rootId,
  ).path;
  const absolutePath = resolveSafeFile(workspacePath, cleanPath);
  if (!fs.existsSync(absolutePath))
    throw new AgentValidationError(`File not found: ${cleanPath}`);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile())
    throw new AgentValidationError(`Not a file: ${cleanPath}`);
  if (stat.size > MAX_PREVIEW_IMAGE_BYTES)
    throw new AgentValidationError(`Media preview exceeds 20 MB: ${cleanPath}`);
  const preview = await readWorkspacePreview(absolutePath, MAX_PREVIEW_IMAGE_BYTES);
  if (preview.truncated) throw new AgentValidationError(`Media preview exceeds 20 MB: ${cleanPath}`);
  const bytes = preview.bytes;
  const mediaType = detectMediaType(bytes, cleanPath);
  if (!mediaType.startsWith("image/") && !mediaType.startsWith("audio/") &&
      !mediaType.startsWith("video/") && mediaType !== "application/pdf")
    throw new AgentValidationError(`Unsupported media preview: ${cleanPath}`);
  return { sessionId, path: cleanPath, mediaType, bytes };
}

export async function getSessionEnvironmentFile(
  sessionId: string,
  relativePath: string,
  kind: "diff" | "input",
  rootId?: string,
): Promise<SessionEnvironmentFileView> {
  const session = getSession(sessionId);
  const cleanPath = assertRelativePath(relativePath);
  const workspacePath = resolveSessionFileRepository(
    sessionId,
    session.projectId,
    cleanPath,
    rootId,
  ).path;
  const absolutePath = resolveSafeFile(workspacePath, cleanPath);
  let content = "";
  let truncated = false;

  if (kind === "diff") {
    const trackedDiff = await readWorkspaceGit(workspacePath, [
      "diff",
      "HEAD",
      "--",
      cleanPath,
    ]);
    if (trackedDiff.trim()) {
      content = trackedDiff;
    } else if (
      fs.existsSync(absolutePath) &&
      !(await readWorkspaceGit(workspacePath, ["ls-files", "--", cleanPath])).trim()
    ) {
      // `git diff HEAD` does not include untracked files; render them as a new-file diff.
      content = await readWorkspaceGit(workspacePath, [
        "diff",
        "--no-index",
        "--",
        "/dev/null",
        absolutePath,
      ]);
    }
  } else {
    if (!fs.existsSync(absolutePath)) {
      throw new AgentValidationError(`File not found: ${cleanPath}`);
    }
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile())
      throw new AgentValidationError(`Not a file: ${cleanPath}`);
    const preview = await readWorkspacePreview(absolutePath, MAX_FILE_BYTES);
    truncated = preview.truncated;
    content = previewText(preview.bytes, truncated);
  }

  return {
    sessionId,
    path: cleanPath,
    kind,
    content,
    truncated,
  };
}
