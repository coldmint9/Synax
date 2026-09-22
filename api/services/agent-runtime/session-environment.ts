import { withCheckpointMutation } from "./checkpoints/mutations.js";
import fs from "node:fs";
import path from "node:path";
import { agentRuntimeStore } from "./session-store.js";
import { resolveSessionWorkspaceRoots } from "./tools/workspace.js";
import {
  canonicalWorkspaceDirectory,
  isWithinWorkspace,
  workspaceRootHostPath,
  workspaceRootLocation,
  type ProjectWorkspaceRoot,
} from "../project-workspace.js";
import { patchFilePaths } from "./tools/patch-format.js";
import { AgentNotFoundError, AgentValidationError } from "./runtime-errors.js";
import type { AgentSessionStatus } from "./contracts.js";
import { runCommand } from "./tools/exec-async.js";
import { detectMediaType, getAsset } from "./media-assets.js";

const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024;

export type EnvironmentChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "unknown";

export interface SessionEnvironmentFile {
  path: string;
  status: EnvironmentChangeStatus;
  additions: number;
  deletions: number;
  staged: boolean;
  untracked: boolean;
}

export interface SessionEnvironmentSubagent {
  id: string;
  parentSessionId: string | null;
  profileId: string;
  status: AgentSessionStatus;
  title: string | null;
  prompt: string;
  updatedAt: string;
  completedAt: string | null;
  resultSummary: string | null;
}

export type SessionEnvironmentInputSourceKind =
  | "file"
  | "search"
  | "command"
  | "url"
  | "attachment"
  | "tool";

export interface SessionEnvironmentInputSource {
  toolCallId?: string;
  kind: SessionEnvironmentInputSourceKind;
  label: string;
  path?: string;
  assetId?: string;
}

export interface SessionEnvironment {
  repositories: SessionEnvironmentRepository[];
  sessionId: string;
  projectId: string;
  workspacePath: string;
  branch: string;
  headCommitSha: string;
  dirty: boolean;
  additions: number;
  deletions: number;
  changedFiles: SessionEnvironmentFile[];
  /**
   * Subset of `changedFiles` that this session's agent actually wrote, edited
   * or deleted. Attribution comes from the session's own write tool calls, so
   * uncommitted work the user did by hand is not counted here.
   */
  agentChangedFiles: SessionEnvironmentFile[];
  /** Existing files written by this session, including already committed outputs. */
  outputFiles: string[];
  inputSources: SessionEnvironmentInputSource[];
  subagents: SessionEnvironmentSubagent[];
  refreshedAt: string;
}

export interface SessionEnvironmentRepository {
  rootId: string;
  name: string;
  role: "primary" | "reference";
  status: "ready" | "missing" | "not_repository" | "error";
  workspacePath: string;
  branch: string;
  headCommitSha: string;
  dirty: boolean;
  additions: number;
  deletions: number;
  changedFiles: SessionEnvironmentFile[];
  agentChangedFiles: SessionEnvironmentFile[];
  outputFiles: string[];
  inputSources: SessionEnvironmentInputSource[];
}

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

async function git(
  workspacePath: string,
  args: string[],
  input?: string,
): Promise<string> {
  const result = await runCommand("git", args, {
    cwd: workspacePath,
    maxBufferBytes: MAX_BUFFER,
    stdin: input,
    timeoutMs: 30_000,
  });
  return result.stdout;
}

function assertRelativePath(relativePath: string): string {
  const clean = relativePath.replace(/\\/g, "/").trim();
  if (
    !clean ||
    clean === "." ||
    clean.startsWith("/") ||
    clean.includes("\0")
  ) {
    throw new AgentValidationError(
      "File path must be a workspace-relative path.",
    );
  }
  const parts = clean.split("/");
  // Segment names such as `.git` are no longer restricted; only traversal is.
  if (parts.includes("..")) {
    throw new AgentValidationError(
      "File path is outside the visible workspace.",
    );
  }
  return clean;
}

export function resolveSafeFile(workspacePath: string, relativePath: string): string {
  const clean = assertRelativePath(relativePath);
  const root = path.resolve(workspacePath);
  const absolute = path.resolve(root, clean);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new AgentValidationError("File path is outside the workspace.");
  }
  if (
    fs.existsSync(absolute) &&
    !isWithinWorkspace(fs.realpathSync(root), fs.realpathSync(absolute))
  ) {
    throw new AgentValidationError("File path is outside the workspace.");
  }
  return absolute;
}

function parseStatus(output: string): Array<{ xy: string; path: string }> {
  const entries: Array<{ xy: string; path: string }> = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    entries.push({ xy, path: record.slice(3) });
    // Porcelain -z puts the destination first, followed by the original path.
    if (xy.includes("R") || xy.includes("C")) index += 1;
  }
  return entries;
}

function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const parts = records[index].split("\t");
    if (parts.length < 3) continue;
    const additions = Number(parts[0]);
    const deletions = Number(parts[1]);
    let filePath = parts.slice(2).join("\t");
    if (!filePath) {
      // Renames have separate original and destination path records with -z.
      filePath = records[index + 2];
      index += 2;
    }
    if (!filePath) continue;
    result.set(filePath, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  return result;
}

function memberRelativePath(
  candidate: string,
  workspacePath: string,
  primaryPath: string,
): string {
  const resolved = path.resolve(primaryPath, candidate);
  const absolute = fs.existsSync(resolved)
    ? fs.realpathSync(resolved)
    : resolved;
  if (!isWithinWorkspace(workspacePath, absolute))
    throw new Error("Another project");
  return assertRelativePath(path.relative(workspacePath, absolute));
}

function readInputSources(
  sessionId: string,
  workspacePath: string,
  primaryPath: string,
): SessionEnvironmentInputSource[] {
  const sources = new Map<string, SessionEnvironmentInputSource>();
  for (const call of agentRuntimeStore.listToolCalls(sessionId)) {
    if (call.status !== "completed" || call.mutability !== "read") continue;
    const envelope =
      call.inputRef && typeof call.inputRef === "object"
        ? (call.inputRef as Record<string, unknown>)
        : {};
    const input =
      envelope.nativeTool && typeof envelope.nativeTool === "object"
        ? (envelope.nativeTool as Record<string, unknown>)
        : envelope;
    const candidate = input.path ?? input.file_path ?? input.notebook_path;
    if (typeof candidate === "string" && candidate.trim()) {
      try {
        const relativePath = memberRelativePath(
          candidate,
          workspacePath,
          primaryPath,
        );
        if (!fs.statSync(path.join(workspacePath, relativePath)).isFile())
          throw new Error("Not a file");
        sources.set(`file:${relativePath}`, {
          toolCallId: call.id,
          kind: "file",
          label: relativePath,
          path: relativePath,
        });
        continue;
      } catch {
        // Ignore paths outside this workspace member; command-style reads are
        // intentionally not listed as input sources below.
      }
    }
    // Only concrete workspace files and external web reads belong in the
    // input source list; search, shell command and generic tool reads would
    // only surface raw JSON summaries here.
    if (!/url|web|http/i.test(call.toolId)) continue;
    const label =
      (typeof input.url === "string" && input.url.trim()) ||
      (typeof input.query === "string" && input.query.trim()) ||
      call.inputSummary?.trim() ||
      call.toolId;
    sources.set(`url:${call.toolId}:${label}`, {
      kind: "url",
      label,
      toolCallId: call.id,
    });
  }
  // Files the user attached to their messages count as input sources too.
  for (const message of agentRuntimeStore.listMessages(sessionId)) {
    if (message.role !== "user" || !Array.isArray(message.contentParts))
      continue;
    for (const part of message.contentParts) {
      if (part.type === "text") continue;
      const assetId = (part as { assetId?: unknown }).assetId;
      if (typeof assetId !== "string" || !assetId) continue;
      let label = assetId;
      try {
        const filename = getAsset(assetId).filename;
        if (filename) label = filename;
      } catch {
        // Asset metadata is gone; fall back to the raw asset id.
      }
      sources.set(`attachment:${assetId}`, {
        kind: "attachment",
        label,
        assetId,
      });
    }
  }
  return [...sources.values()];
}

/** Tools whose execution means "this session wrote to that path". */
const AGENT_WRITE_TOOL_IDS = new Set([
  "edit",
  "file.write",
  "file.delete",
  "file.patch",
]);

function readAgentEditedPaths(
  sessionId: string,
  workspacePath: string,
  primaryPath: string,
): Set<string> {
  const paths = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string" || !candidate.trim()) return;
    try {
      paths.add(memberRelativePath(candidate, workspacePath, primaryPath));
    } catch {
      /* Ignore paths outside this workspace member. */
    }
  };
  for (const call of agentRuntimeStore.listToolCalls(sessionId)) {
    if (call.status !== "completed") continue;
    const raw = call.inputRef;
    if (!raw || typeof raw !== "object") continue;
    const envelope = raw as Record<string, unknown>;
    const input =
      envelope.nativeTool && typeof envelope.nativeTool === "object"
        ? (envelope.nativeTool as Record<string, unknown>)
        : envelope;
    if (call.toolId === "codex.fileChange") {
      // Codex sends the definitive changed paths with the completed result.
      const changes = Array.isArray(call.outputRef)
        ? call.outputRef
        : input.changes;
      if (Array.isArray(changes))
        for (const change of changes) {
          if (change && typeof change === "object")
            add((change as { path?: unknown }).path);
        }
    } else if (/^claude-code\.(Write|Edit|NotebookEdit)$/.test(call.toolId)) {
      add(input.file_path ?? input.notebook_path);
    } else if (call.toolId === "file.patch") {
      for (const candidate of patchFilePaths(input.patch)) add(candidate);
    } else if (AGENT_WRITE_TOOL_IDS.has(call.toolId)) {
      add(input.path);
    }
  }
  return paths;
}

/**
 * `git diff HEAD --numstat` reports nothing for untracked files, so a file the
 * agent just created would otherwise show as "+0". Count its lines instead.
 */
function countUntrackedAdditions(
  workspacePath: string,
  relativePath: string,
): number {
  try {
    const absolute = resolveSafeFile(workspacePath, relativePath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return 0;
    const content = fs.readFileSync(absolute, "utf8");
    if (!content) return 0;
    return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}

function getSession(sessionId: string) {
  try {
    return agentRuntimeStore.getSession(sessionId);
  } catch {
    throw new AgentNotFoundError(sessionId);
  }
}

/**
 * Cache + single-flight for the workspace/profile snapshot.
 *
 * The panel polls this endpoint while a run is in flight, and every call used
 * to spawn four git processes (status/diff/rev-parse/branch). Coalescing the
 * polls keeps that side-channel work from competing with the run itself.
 */
const ENVIRONMENT_CACHE_TTL_MS = 5_000;
const environmentCache = new Map<
  string,
  { at: number; value: SessionEnvironment }
>();
const environmentInFlight = new Map<string, Promise<SessionEnvironment>>();

export async function getSessionEnvironment(
  sessionId: string,
): Promise<SessionEnvironment> {
  const cached = environmentCache.get(sessionId);
  if (cached && Date.now() - cached.at < ENVIRONMENT_CACHE_TTL_MS) {
    return cached.value;
  }
  const pending = environmentInFlight.get(sessionId);
  if (pending) return pending;

  const task = computeSessionEnvironment(sessionId);
  environmentInFlight.set(sessionId, task);
  try {
    const value = await task;
    environmentCache.set(sessionId, { at: Date.now(), value });
    return value;
  } finally {
    environmentInFlight.delete(sessionId);
  }
}

export function invalidateSessionEnvironment(sessionId: string): void {
  environmentCache.delete(sessionId);
  environmentInFlight.delete(sessionId);
}

async function computeRepository(
  sessionId: string,
  root: ProjectWorkspaceRoot,
  primaryPath: string,
): Promise<SessionEnvironmentRepository> {
  const empty: SessionEnvironmentRepository = {
    rootId: root.id,
    name: root.name,
    role: root.role,
    status: "ready",
    workspacePath: root.path,
    branch: "",
    headCommitSha: "",
    dirty: false,
    additions: 0,
    deletions: 0,
    changedFiles: [],
    agentChangedFiles: [],
    outputFiles: [],
    inputSources: [],
  };
  let workspacePath: string;
  try {
    workspacePath = canonicalWorkspaceDirectory(workspaceRootHostPath(root));
  } catch {
    return { ...empty, status: "missing" };
  }
  const edited = readAgentEditedPaths(sessionId, workspacePath, primaryPath);
  const outputFiles = [...edited].filter((relativePath) => {
    try {
      return fs.statSync(resolveSafeFile(workspacePath, relativePath)).isFile();
    } catch {
      return false;
    }
  });
  const repoRoot = (
    await git(workspacePath, ["rev-parse", "--show-toplevel"])
  ).trim();
  const rootLocation = workspaceRootLocation(root);
  const repositoryMatches =
    rootLocation.kind === "wsl"
      ? path.posix.normalize(repoRoot) ===
        path.posix.normalize(rootLocation.path)
      : Boolean(repoRoot) &&
        canonicalWorkspaceDirectory(repoRoot) === workspacePath;
  if (!repositoryMatches) {
    return {
      ...empty,
      outputFiles,
      inputSources: readInputSources(sessionId, workspacePath, primaryPath),
      status: "not_repository",
    };
  }
  const [branchRaw, headCommitShaRaw, statusRaw, numstatRaw] =
    await Promise.all([
      git(workspacePath, ["branch", "--show-current"]),
      git(workspacePath, ["rev-parse", "--verify", "HEAD"]),
      git(workspacePath, ["status", "--porcelain=v1", "-uall", "-z"]),
      git(workspacePath, ["diff", "HEAD", "--numstat", "-z"]),
    ]);

  const numstat = parseNumstat(
    numstatRaw ||
      (!headCommitShaRaw.trim()
        ? await git(workspacePath, ["diff", "--cached", "--numstat", "-z"])
        : ""),
  );
  const statusEntries = parseStatus(statusRaw);
  // Status already excludes ignored untracked files. Check without the index
  // so tracked files (including staged deletions) also respect ignore rules.
  // NUL delimiters preserve spaces, Unicode and newlines in file names.
  const ignoredPaths = new Set(
    statusEntries.length > 0
      ? (
          await git(
            workspacePath,
            ["check-ignore", "--no-index", "--stdin", "-z"],
            `${statusEntries.map((entry) => entry.path).join("\0")}\0`,
          )
        ).split("\0")
      : [],
  );
  const changedFiles: SessionEnvironmentFile[] = [];
  for (const parsed of statusEntries) {
    if (ignoredPaths.has(parsed.path)) continue;
    const status = parsed.xy.includes("R")
      ? "renamed"
      : parsed.xy === "??"
        ? "untracked"
        : parsed.xy.includes("A")
          ? "added"
          : parsed.xy.includes("D")
            ? "deleted"
            : parsed.xy.includes("M")
              ? "modified"
              : "unknown";
    const stats =
      numstat.get(parsed.path) ??
      (parsed.xy === "??"
        ? {
            additions: countUntrackedAdditions(workspacePath, parsed.path),
            deletions: 0,
          }
        : { additions: 0, deletions: 0 });
    changedFiles.push({
      path: parsed.path,
      status,
      additions: stats.additions,
      deletions: stats.deletions,
      staged: parsed.xy[0] !== " " && parsed.xy !== "??",
      untracked: parsed.xy === "??",
    });
  }

  return {
    ...empty,
    branch: branchRaw.trim() || "HEAD",
    headCommitSha: headCommitShaRaw.trim(),
    dirty: changedFiles.length > 0,
    additions: changedFiles.reduce((sum, file) => sum + file.additions, 0),
    deletions: changedFiles.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles,
    agentChangedFiles: changedFiles.filter((file) => edited.has(file.path)),
    outputFiles,
    inputSources: readInputSources(sessionId, workspacePath, primaryPath),
  };
}

async function computeSessionEnvironment(
  sessionId: string,
): Promise<SessionEnvironment> {
  const session = getSession(sessionId);
  const roots = resolveSessionWorkspaceRoots(sessionId, session.projectId);
  const primary = roots.find((root) => root.role === "primary");
  if (!primary)
    throw new AgentValidationError("The session has no workspace projects.");
  const repositories = await Promise.all(
    roots.map((root) =>
      computeRepository(sessionId, root, workspaceRootHostPath(primary)),
    ),
  );
  const main = repositories.find((root) => root.role === "primary")!;
  const subagents: SessionEnvironmentSubagent[] = [];
  for (const childId of session.childSessionIds ?? []) {
    try {
      const child = agentRuntimeStore.getSession(childId);
      subagents.push({
        id: child.id,
        parentSessionId: child.parentSessionId,
        profileId: child.profileId,
        status: child.status,
        title: child.title,
        prompt: child.prompt,
        updatedAt: child.updatedAt,
        completedAt: child.completedAt,
        resultSummary: child.resultSummary,
      });
    } catch {
      // child may have been deleted; skip
    }
  }

  return {
    ...main,
    sessionId,
    projectId: session.projectId,
    repositories,
    subagents,
    refreshedAt: new Date().toISOString(),
  };
}

export function getSessionInputSourceContent(
  sessionId: string,
  toolCallId: string,
) {
  getSession(sessionId);
  const call = agentRuntimeStore.getToolCall(sessionId, toolCallId);
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
  await withCheckpointMutation(
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
  const workspacePath = resolveSessionRepository(
    sessionId,
    session.projectId,
    rootId,
  ).path;
  const cleanPath = assertRelativePath(relativePath);
  const absolutePath = resolveSafeFile(workspacePath, cleanPath);
  if (!fs.existsSync(absolutePath))
    throw new AgentValidationError(`File not found: ${cleanPath}`);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile())
    throw new AgentValidationError(`Not a file: ${cleanPath}`);
  if (stat.size > MAX_PREVIEW_IMAGE_BYTES)
    throw new AgentValidationError(`Image preview exceeds 20 MB: ${cleanPath}`);
  const bytes = fs.readFileSync(absolutePath);
  const mediaType = detectMediaType(bytes, cleanPath);
  if (!mediaType.startsWith("image/"))
    throw new AgentValidationError(`Unsupported image preview: ${cleanPath}`);
  return { sessionId, path: cleanPath, mediaType, bytes };
}

export async function getSessionEnvironmentFile(
  sessionId: string,
  relativePath: string,
  kind: "diff" | "input",
  rootId?: string,
): Promise<SessionEnvironmentFileView> {
  const session = getSession(sessionId);
  const workspacePath = resolveSessionRepository(
    sessionId,
    session.projectId,
    rootId,
  ).path;
  const cleanPath = assertRelativePath(relativePath);
  const absolutePath = resolveSafeFile(workspacePath, cleanPath);
  let content = "";

  if (kind === "diff") {
    const trackedDiff = await git(workspacePath, [
      "diff",
      "HEAD",
      "--",
      cleanPath,
    ]);
    if (trackedDiff.trim()) {
      content = trackedDiff;
    } else if (
      fs.existsSync(absolutePath) &&
      !(await git(workspacePath, ["ls-files", "--", cleanPath])).trim()
    ) {
      // `git diff HEAD` does not include untracked files; render them as a new-file diff.
      content = await git(workspacePath, [
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
    content = fs
      .readFileSync(absolutePath)
      .subarray(0, MAX_FILE_BYTES)
      .toString("utf8");
  }

  return {
    sessionId,
    path: cleanPath,
    kind,
    content,
    truncated:
      kind === "input" && Buffer.byteLength(content, "utf8") >= MAX_FILE_BYTES,
  };
}
