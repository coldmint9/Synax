import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalWorkspaceDirectory,
  projectWorkspaceRoots,
  readWorkspaceProject,
  workspaceRootHostPath,
  workspaceRootLocation,
  type ProjectWorkspaceRoot,
} from "../project-workspace.js";
import { agentRuntimeStore } from "./session-store.js";
import { runCommand } from "./tools/exec-async.js";
import { resolveSessionWorkspaceRoots } from "./tools/workspace.js";
import { AgentValidationError } from "./runtime-errors.js";
import { resolveSafeFile } from "./workspace-paths.js";

/**
 * Workspace-level Git changes.
 *
 * Git facts belong to a worktree, not to a conversation: two sessions opened on
 * the same checkout must share one probe and one cached result. Everything in
 * this module is keyed by the canonical workspace path, so a session switch is
 * a cache hit instead of a fresh `git status`.
 */

const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;

export type EnvironmentChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "unknown";

export interface WorkspaceGitFile {
  path: string;
  status: EnvironmentChangeStatus;
  additions: number;
  deletions: number;
  staged: boolean;
  untracked: boolean;
}

export type WorkspaceRepositoryStatus =
  | "ready"
  | "missing"
  | "not_repository"
  | "error";

export interface WorkspaceRepositoryGit {
  rootId: string;
  name: string;
  role: "primary" | "reference";
  status: WorkspaceRepositoryStatus;
  workspacePath: string;
  branch: string;
  headCommitSha: string;
  unpushedCommitCount: number;
  dirty: boolean;
  additions: number;
  deletions: number;
  changedFiles: WorkspaceGitFile[];
  /** Content hash of these facts; the client merges by this value per root. */
  revision: string;
}

export interface WorkspaceGitChanges {
  projectId: string;
  /** Content hash of every repository revision in this workspace. */
  revision: string;
  /**
   * True when the caller already holds `revision`. `repositories` is empty in
   * that case: nothing is transferred, the client keeps its objects as-is.
   */
  unchanged: boolean;
  repositories: WorkspaceRepositoryGit[];
  refreshedAt: string;
}

interface RepositoryGitFacts {
  status: WorkspaceRepositoryStatus;
  branch: string;
  headCommitSha: string;
  unpushedCommitCount: number;
  dirty: boolean;
  additions: number;
  deletions: number;
  changedFiles: WorkspaceGitFile[];
}

// Shared read-only Git probes: two sessions in the same worktree must not
// launch the same five Git commands independently. Never cache mutating commands.
const gitReads = new Map<
  string,
  { root: string; at: number; pending: boolean; bytes: number; value: Promise<string> }
>();
const GIT_CACHE_BYTES = 16 * 1024 * 1024;
/** Working files change far more often than branch, HEAD, or committed diffs. */
const GIT_CACHE_TTL_MS = 15_000;

export async function readWorkspaceGit(
  workspacePath: string,
  args: string[],
  input?: string,
): Promise<string> {
  const key = JSON.stringify([workspacePath, args, input]);
  const previous = gitReads.get(key);
  if (previous && (previous.pending || Date.now() - previous.at < GIT_CACHE_TTL_MS))
    return previous.value;
  const entry = {
    root: workspacePath,
    at: Date.now(),
    pending: true,
    bytes: 0,
    value: Promise.resolve(""),
  };
  entry.value = runCommand("git", args, {
    cwd: workspacePath,
    maxBufferBytes: MAX_BUFFER,
    stdin: input,
    timeoutMs: 30_000,
  }).then(
    (result) => {
      entry.at = Date.now();
      entry.pending = false;
      entry.bytes = Buffer.byteLength(result.stdout);
      let bytes = [...gitReads.values()].reduce((sum, item) => sum + item.bytes, 0);
      for (const [oldKey, old] of gitReads) {
        if (gitReads.size <= 128 && bytes <= GIT_CACHE_BYTES) break;
        if (old.pending) continue;
        gitReads.delete(oldKey);
        bytes -= old.bytes;
      }
      return result.stdout;
    },
    (error) => {
      if (gitReads.get(key) === entry) gitReads.delete(key);
      throw error;
    },
  );
  gitReads.delete(key);
  gitReads.set(key, entry);
  return entry.value;
}

/**
 * Parsed `git status` + `git diff` facts per worktree. Recomputing costs a few
 * subprocess calls, so a short TTL plus single-flight keeps a burst of panel
 * reads (or several sessions on one checkout) down to a single probe.
 */
const FACTS_TTL_MS = 10_000;
const FACTS_CACHE_LIMIT = 32;
const factsCache = new Map<
  string,
  { facts: RepositoryGitFacts; revision: string; at: number }
>();
const factsInFlight = new Map<
  string,
  Promise<{ facts: RepositoryGitFacts; revision: string }>
>();

function parseStatus(output: string): Array<{ xy: string; path: string }> {
  const entries: Array<{ xy: string; path: string }> = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith("## ")) continue;
    if (record.startsWith("1 ")) {
      const match = record.match(/^1 (\S{2}) (?:\S+ ){6}(.+)$/s);
      if (match) entries.push({ xy: match[1], path: match[2] });
      continue;
    }
    if (record.startsWith("2 ")) {
      const match = record.match(/^2 (\S{2}) (?:\S+ ){7}(.+)$/s);
      if (match) entries.push({ xy: match[1], path: match[2] });
      index += 1;
      continue;
    }
    if (record.startsWith("u ")) {
      const match = record.match(/^u (\S{2}) (?:\S+ ){9}(.+)$/s);
      if (match) entries.push({ xy: match[1], path: match[2] });
      continue;
    }
    if (record.startsWith("? "))
      entries.push({ xy: "??", path: record.slice(2) });
    // Existing probes use porcelain v1; retain v2 support for cached/alternate
    // producers. In NUL mode a rename has a separate original-path record.
    else if (/^[ MADRCU?!T]{2} /.test(record)) {
      const xy = record.slice(0, 2);
      entries.push({ xy, path: record.slice(3) });
      if (xy.includes('R') || xy.includes('C')) index += 1;
    }
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

function hashFacts(facts: RepositoryGitFacts): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        facts.status,
        facts.branch,
        facts.headCommitSha,
        facts.unpushedCommitCount,
        facts.changedFiles.map((file) => [
          file.path,
          file.status,
          file.additions,
          file.deletions,
          file.staged,
          file.untracked,
        ]),
      ]),
    )
    .digest("hex")
    .slice(0, 12);
}

const EMPTY_FACTS: RepositoryGitFacts = {
  status: "ready",
  branch: "",
  headCommitSha: "",
  unpushedCommitCount: 0,
  dirty: false,
  additions: 0,
  deletions: 0,
  changedFiles: [],
};

async function computeRepositoryFacts(
  root: ProjectWorkspaceRoot,
  workspacePath: string,
): Promise<RepositoryGitFacts> {
  let repoRoot = "";
  try {
    repoRoot = (
      await readWorkspaceGit(workspacePath, ["rev-parse", "--show-toplevel"])
    ).trim();
  } catch {
    // Not a checkout at all: report it like a directory that is not a repo.
    return { ...EMPTY_FACTS, status: "not_repository" };
  }
  const rootLocation = workspaceRootLocation(root);
  const repositoryMatches =
    rootLocation.kind === "wsl"
      ? path.posix.normalize(repoRoot) === path.posix.normalize(rootLocation.path)
      : Boolean(repoRoot) &&
        canonicalWorkspaceDirectory(repoRoot) === workspacePath;
  if (!repositoryMatches) return { ...EMPTY_FACTS, status: "not_repository" };

  const [branchRaw, headCommitShaRaw, statusRaw, numstatRaw] = await Promise.all([
    readWorkspaceGit(workspacePath, ["branch", "--show-current"]),
    readWorkspaceGit(workspacePath, ["rev-parse", "--verify", "HEAD"]),
    readWorkspaceGit(workspacePath, [
      "status",
      "--porcelain=v1",
      "--branch",
      "-uall",
      "-z",
    ]),
    readWorkspaceGit(workspacePath, ["diff", "HEAD", "--numstat", "-z"]),
  ]);

  const numstat = parseNumstat(
    numstatRaw ||
      (!headCommitShaRaw.trim()
        ? await readWorkspaceGit(workspacePath, [
            "diff",
            "--cached",
            "--numstat",
            "-z",
          ])
        : ""),
  );
  const statusEntries = parseStatus(statusRaw);
  // Status already excludes ignored untracked files. Check without the index
  // so tracked files (including staged deletions) also respect ignore rules.
  // NUL delimiters preserve spaces, Unicode and newlines in file names.
  const ignoredPaths = new Set(
    statusEntries.length > 0
      ? (
          await readWorkspaceGit(
            workspacePath,
            ["check-ignore", "--no-index", "--stdin", "-z"],
            `${statusEntries.map((entry) => entry.path).join("\0")}\0`,
          )
        ).split("\0")
      : [],
  );
  const changedFiles: WorkspaceGitFile[] = [];
  for (const parsed of statusEntries) {
    if (ignoredPaths.has(parsed.path)) continue;
    const status: EnvironmentChangeStatus = parsed.xy.includes("R")
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

  let unpushedCommitCount = Number(
    statusRaw.match(
      /(?:^|\0)## [^\0]*\[ahead (\d+)(?:, behind \d+)?\]/,
    )?.[1] ?? 0,
  );
  if (
    branchRaw.trim() &&
    headCommitShaRaw &&
    !/(?:^|\0)## [^\0]*\[ahead /.test(statusRaw) &&
      (await readWorkspaceGit(workspacePath, ["remote"])).trim()
  ) {
    const fallback = Number(
      (
        await readWorkspaceGit(workspacePath, [
          "rev-list",
          "--count",
          "HEAD",
          "--not",
          "--remotes",
        ])
      ).trim(),
    );
    unpushedCommitCount =
      Number.isSafeInteger(fallback) && fallback > 0 ? fallback : 0;
  }

  return {
    status: "ready",
    branch: branchRaw.trim() || "HEAD",
    headCommitSha: headCommitShaRaw.trim(),
    unpushedCommitCount:
      Number.isSafeInteger(unpushedCommitCount) && unpushedCommitCount > 0
        ? unpushedCommitCount
        : 0,
    dirty: changedFiles.length > 0,
    additions: changedFiles.reduce((sum, file) => sum + file.additions, 0),
    deletions: changedFiles.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles,
  };
}

async function loadRepositoryFacts(
  root: ProjectWorkspaceRoot,
  workspacePath: string,
): Promise<{ facts: RepositoryGitFacts; revision: string }> {
  const pending = factsInFlight.get(workspacePath);
  if (pending) return pending;
  const cached = factsCache.get(workspacePath);
  if (cached && Date.now() - cached.at < FACTS_TTL_MS)
    return { facts: cached.facts, revision: cached.revision };

  const task = computeRepositoryFacts(root, workspacePath)
    .then((facts) => {
      const revision = hashFacts(facts);
      factsCache.delete(workspacePath);
      factsCache.set(workspacePath, { facts, revision, at: Date.now() });
      while (factsCache.size > FACTS_CACHE_LIMIT)
        factsCache.delete(factsCache.keys().next().value!);
      return { facts, revision };
    })
    .finally(() => {
      if (factsInFlight.get(workspacePath) === task) factsInFlight.delete(workspacePath);
    });
  factsInFlight.set(workspacePath, task);
  return task;
}

function resolveWorkspaceGitRoots(
  projectId: string,
  sessionId?: string,
): ProjectWorkspaceRoot[] {
  if (sessionId) {
    const session = agentRuntimeStore.tryGetSession?.(sessionId);
    // A session may pin its own roots; honour that binding when it still
    // belongs to the project the request is scoped to.
    if (session && session.projectId === projectId)
      return resolveSessionWorkspaceRoots(sessionId, projectId);
  }
  const project = readWorkspaceProject(projectId);
  if (!project) throw new AgentValidationError("Project workspace not found.");
  const roots = projectWorkspaceRoots(project);
  if (roots.length === 0)
    throw new AgentValidationError("The project has no workspace directories.");
  return roots;
}

function workspaceRevision(repositories: WorkspaceRepositoryGit[]): string {
  const signature = [...repositories]
    .sort((a, b) => a.rootId.localeCompare(b.rootId))
    .map((repository) => JSON.stringify([repository.rootId, repository.workspacePath, repository.revision]))
    .join("|");
  return createHash("sha1").update(signature).digest("hex").slice(0, 12);
}

export interface WorkspaceGitRequest {
  projectId: string;
  /** Optional session whose root binding should win over the project default. */
  sessionId?: string;
  /** Revision the client already holds; a match skips the whole payload. */
  clientRevision?: string;
}

/**
 * Workspace-scoped Git changes.
 *
 * The revision is a content hash, so an unchanged checkout answers with
 * `{ unchanged: true, revision }` and no file list, while a switch between two
 * sessions of the same workspace never re-probes the checkout.
 */
export async function getWorkspaceGitChanges({
  projectId,
  sessionId,
  clientRevision,
}: WorkspaceGitRequest): Promise<WorkspaceGitChanges> {
  const roots = resolveWorkspaceGitRoots(projectId, sessionId);
  const repositories = await Promise.all(
    roots.map(async (root): Promise<WorkspaceRepositoryGit> => {
      const identity = {
        rootId: root.id,
        name: root.name,
        role: root.role,
      };
      let workspacePath: string;
      try {
        workspacePath = canonicalWorkspaceDirectory(workspaceRootHostPath(root));
      } catch {
        return {
          ...identity,
          status: "missing",
          workspacePath: root.path ?? "",
          branch: "",
          headCommitSha: "",
          unpushedCommitCount: 0,
          dirty: false,
          additions: 0,
          deletions: 0,
          changedFiles: [],
          revision: hashFacts({ ...EMPTY_FACTS, status: "missing" }),
        };
      }
      try {
        const { facts, revision } = await loadRepositoryFacts(root, workspacePath);
        return { ...identity, workspacePath, ...facts, revision };
      } catch {
        return {
          ...identity,
          status: "error",
          workspacePath,
          branch: "",
          headCommitSha: "",
          unpushedCommitCount: 0,
          dirty: false,
          additions: 0,
          deletions: 0,
          changedFiles: [],
          revision: hashFacts({ ...EMPTY_FACTS, status: "error" }),
        };
      }
    }),
  );
  const revision = workspaceRevision(repositories);
  const refreshedAt = new Date().toISOString();
  if (clientRevision && clientRevision === revision)
    return {
      projectId,
      revision,
      unchanged: true,
      repositories: [],
      refreshedAt,
    };
  return { projectId, revision, unchanged: false, repositories, refreshedAt };
}

function forgetWorkspacePath(workspacePath: string): void {
  factsCache.delete(workspacePath);
  factsInFlight.delete(workspacePath);
  for (const [key, entry] of gitReads)
    if (entry.root === workspacePath) gitReads.delete(key);
}

/** Explicit invalidation after a mutation (write tool, commit, restore, …). */
export function invalidateWorkspaceGitPaths(paths: Iterable<string>): void {
  for (const workspacePath of paths) forgetWorkspacePath(workspacePath);
}

export function invalidateWorkspaceGitForSession(sessionId: string): void {
  try {
    const session = agentRuntimeStore.tryGetSession?.(sessionId);
    if (!session) return;
    const paths = new Set<string>();
    for (const root of resolveSessionWorkspaceRoots(sessionId, session.projectId)) {
      try {
        paths.add(canonicalWorkspaceDirectory(workspaceRootHostPath(root)));
      } catch {
        // A missing directory has no cached facts to drop.
      }
    }
    invalidateWorkspaceGitPaths(paths);
  } catch {
    // Session or project metadata may already be gone.
  }
}

export function invalidateAllWorkspaceGit(): void {
  factsCache.clear();
  factsInFlight.clear();
  gitReads.clear();
}
