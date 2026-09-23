import fs from "node:fs/promises";
import path from "node:path";
import { DATA_ROOT } from "../../../lib/env.js";
import { runCommand } from "../tools/exec-async.js";
import { parseWslUncPath } from "../../workspace-location.js";
import { sessionRoots, historyError } from "./guards.js";
import { reserveExternalBytes } from "./resource-admission.js";

export type ForkWorkspaceMode = "new_worktree" | "reuse_worktree";
export interface ForkWorkspace {
  source: string;
  path: string;
  commit: string;
  workDir: string;
}
const git = async (cwd: string, args: string[], maxBufferBytes = 64 * 1024) => {
  const result = await runCommand("git", args, {
    cwd,
    timeoutMs: 30_000,
    maxBufferBytes,
  });
  if (result.status !== 0 || result.stdoutTruncated)
    throw historyError(
      `Git worktree preparation failed: ${result.stderr.slice(0, 2000) || "repository output exceeds its budget"}`,
      "FORK_WORKTREE_UNAVAILABLE",
    );
  return result.stdout.trim();
};
export async function inspectForkWorkspace(
  sessionId: string,
  workDir: string,
): Promise<{ source: string; commit: string; relative: string }> {
  if (parseWslUncPath(workDir))
    throw historyError(
      "New-worktree forks currently require a local Git workspace; choose reuse for WSL.",
      "FORK_WORKTREE_UNAVAILABLE",
    );
  const source = await fs.realpath(
    await git(workDir, ["rev-parse", "--show-toplevel"]),
  );
  if (
    sessionRoots(sessionId).some((root) => {
      const rel = path.relative(source, root);
      return (
        rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
      );
    })
  )
    throw historyError(
      "New-worktree fork requires all workspace roots in one Git repository. Choose reuse for multi-repository sessions.",
      "FORK_WORKTREE_UNAVAILABLE",
    );
  const commit = await git(source, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!/^[a-f0-9]{40,64}$/.test(commit))
    throw historyError("A committed Git HEAD is required.");
  return {
    source,
    commit,
    relative: path.relative(source, await fs.realpath(workDir)),
  };
}
/** Git checks out the captured commit; no recursive workspace copy, ignored
 * files, dirty overlay, hooks, smudge processes, or submodule recursion. */
export async function createForkWorkspace(
  info: { source: string; commit: string; relative: string },
  targetId: string,
  record: (workspace: ForkWorkspace) => void,
): Promise<ForkWorkspace> {
  const listing = await git(
    info.source,
    ["ls-tree", "-r", "-l", "--full-tree", info.commit],
    2 * 1024 * 1024,
  );
  let bytes = 0,
    files = 0;
  for (const line of listing.split("\n")) {
    if (!line) continue;
    const match = /^[0-7]{6} (?:blob|commit) [a-f0-9]+\s+(\d+|-)\t/.exec(line);
    if (!match)
      throw historyError("Cannot estimate Git worktree storage safely.");
    bytes +=
      Math.ceil(Number(match[1] === "-" ? 0 : match[1]) / 4096) * 4096 + 4096;
    if (++files > 20_000 || bytes > 128 * 1024 * 1024)
      throw historyError(
        "Worktree exceeds the bounded checkout budget. Choose reuse instead.",
        "FORK_WORKTREE_BUDGET",
      );
  }
  const directory = path.resolve(DATA_ROOT, "conversation-forks");
  const release = await reserveExternalBytes(directory, bytes, 64);
  let committed = false;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, targetId);
    const workspace = {
      source: info.source,
      path: destination,
      commit: info.commit,
      workDir: path.join(destination, info.relative),
    };
    record(workspace); // Durable BEFORE Git changes its worktree registry.
    const filterConfig = await runCommand(
      "git",
      [
        "config",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(smudge|process|required)$",
      ],
      { cwd: info.source, timeoutMs: 5000, maxBufferBytes: 64 * 1024 },
    );
    if (
      (filterConfig.status !== 0 && filterConfig.status !== 1) ||
      filterConfig.stdoutTruncated
    )
      throw historyError("Cannot disable checkout filters safely.");
    const filterKeys = filterConfig.stdout.trim().split("\n").filter(Boolean);
    if (
      filterKeys.some(
        (key) =>
          !/^filter\.[A-Za-z0-9_.-]+\.(smudge|process|required)$/.test(key),
      )
    )
      throw historyError(
        "Cannot safely override this repository's checkout filter names.",
      );
    const overrides = filterKeys.flatMap((key) => [
      "-c",
      `${key}=${key.endsWith(".required") ? "false" : ""}`,
    ]);
    const hooks = path.join(directory, ".empty-hooks");
    await fs.mkdir(hooks, { recursive: true, mode: 0o700 });
    const result = await runCommand(
      "git",
      [
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "submodule.recurse=false",
        "-c",
        "core.fsmonitor=false",
        ...overrides,
        "worktree",
        "add",
        "--detach",
        destination,
        info.commit,
      ],
      {
        cwd: info.source,
        timeoutMs: 30_000,
        maxBufferBytes: 64 * 1024,
        env: {
          ...process.env,
          GIT_LFS_SKIP_SMUDGE: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    if (result.status !== 0)
      throw historyError(
        `Cannot create Git worktree: ${result.stderr.slice(0, 2000)}`,
        "FORK_WORKTREE_UNAVAILABLE",
      );
    committed = true;
    return workspace;
  } finally {
    release(committed);
  }
}
export async function removeForkWorkspace(
  workspace: ForkWorkspace,
): Promise<void> {
  const result = await runCommand(
    "git",
    ["worktree", "remove", "--force", workspace.path],
    { cwd: workspace.source, timeoutMs: 30_000, maxBufferBytes: 64 * 1024 },
  );
  if (result.status !== 0) {
    if (await fs.stat(workspace.path).catch(() => null))
      throw historyError("Unpublished worktree requires cleanup.");
    const registered = await git(workspace.source, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (registered.includes(`worktree ${workspace.path}\0`))
      throw historyError("Unpublished worktree registration requires cleanup.");
  }
}
