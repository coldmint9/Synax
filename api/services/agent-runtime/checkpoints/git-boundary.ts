import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { parseWslUncPath } from "../../workspace-location.js";
import { wslCommandSpec } from "../../wsl.js";
import type { FileChange, GitBoundary } from "./files.js";
const execute = promisify(execFile);
async function git(root: string, args: string[]): Promise<string> {
  const wsl = parseWslUncPath(root),
    spec = wsl
      ? wslCommandSpec(wsl.distribution, wsl.path, "git", args)
      : { command: "git", args };
  return (
    await execute(spec.command, spec.args, {
      cwd: wsl ? undefined : root,
      env: { ...process.env, LC_ALL: "C" },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
}
async function hasGitMarker(root: string): Promise<boolean> {
  for (let directory = root; ; directory = path.dirname(directory)) {
    try {
      await fs.lstat(path.join(directory, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    if (path.dirname(directory) === directory) return false;
  }
}
async function headState(
  root: string,
): Promise<{ head: string | null; unverified?: boolean }> {
  try {
    return { head: await git(root, ["rev-parse", "--verify", "HEAD"]) };
  } catch {
    // A genuinely unborn branch is different from an unreadable or damaged repo.
    try {
      const ref = await git(root, ["symbolic-ref", "--quiet", "HEAD"]);
      try {
        await git(root, ["show-ref", "--verify", "--quiet", ref]);
      } catch (error) {
        if ((error as { code?: number }).code === 1) return { head: null };
      }
    } catch {
      /* unverifiable; never treat a Git failure as permission to undo */
    }
    return { head: null, unverified: true };
  }
}
export async function recordGitBoundary(
  root: string,
  relative: string,
): Promise<GitBoundary | undefined> {
  let prefix: string;
  try {
    prefix = await git(root, ["rev-parse", "--show-prefix"]);
  } catch (error) {
    const failure = error as { code?: string | number; stderr?: string };
    if (
      (failure.code === "ENOENT" ||
        /not a git repository/i.test(failure.stderr ?? "")) &&
      !(await hasGitMarker(root))
    )
      return undefined;
    return { root, path: relative, head: null, unverified: true };
  }
  return {
    root,
    path: path.posix.join(prefix, relative),
    ...(await headState(root)),
  };
}
export interface GitPreservation {
  kind: "committed" | "git_unverified";
  reason: string;
}
const unknown = (): GitPreservation => ({
  kind: "git_unverified",
  reason:
    "Git history or commit status could not be verified; the file is preserved.",
});
export async function fileGitPreservation(
  change: FileChange,
): Promise<GitPreservation | null> {
  const boundary =
    change.git ?? (await recordGitBoundary(change.root, change.path));
  if (!boundary) return null;
  if (boundary.unverified) return unknown();
  const current = await headState(boundary.root);
  if (current.unverified || (!current.head && Boolean(boundary.head)))
    return unknown();
  if (!current.head || current.head === change.git?.head) return null;
  if (change.git?.head) {
    try {
      await git(boundary.root, [
        "merge-base",
        "--is-ancestor",
        change.git.head,
        current.head,
      ]);
    } catch {
      return unknown();
    }
  }
  const range = change.git?.head
    ? [`${change.git.head}..${current.head}`]
    : [current.head];
  try {
    const commit = await git(boundary.root, [
      "log",
      "-1",
      "--format=%H",
      ...range,
      "--",
      `:(top,literal)${boundary.path}`,
    ]);
    return commit
      ? {
          kind: "committed",
          reason:
            "This file has been committed to Git; committed changes are preserved.",
        }
      : null;
  } catch {
    return unknown();
  }
}
export async function committedFileReason(
  change: FileChange,
): Promise<string | null> {
  return (await fileGitPreservation(change))?.reason ?? null;
}
