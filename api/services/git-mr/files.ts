import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { git, safeWorktreeFile, MAX_FILE_BYTES } from "./repository.js";
import { GitMrError } from "./errors.js";
import type {
  MergeFile,
  MergeFileSummary,
  MergeFileSave,
  MergeRequest,
} from "./contracts.js";
const digest = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
export const fileId = (file: string) => digest(file);
interface Entry {
  stage: number;
  oid: string;
  mode: string;
  path: string;
}
async function entries(mr: MergeRequest): Promise<Entry[]> {
  if (!mr.worktree) return [];
  const output = await git(mr, ["ls-files", "--stage", "-z"], {
    cwd: mr.worktree,
  });
  return output.stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const split = record.indexOf("\t");
      const [mode, oid, stage] = record.slice(0, split).split(" ");
      return { mode, oid, stage: Number(stage), path: record.slice(split + 1) };
    });
}
export async function listFiles(mr: MergeRequest): Promise<MergeFileSummary[]> {
  if (!mr.worktree) return [];
  const staged = await entries(mr);
  const conflicts = new Set(
    staged.filter((entry) => entry.stage !== 0).map((entry) => entry.path),
  );
  const diff = await git(
    mr,
    ["diff", "--name-status", "--no-renames", "-z", mr.targetOid, "--"],
    { cwd: mr.worktree },
  );
  const pieces = diff.stdout.split("\0");
  const files = new Map<string, MergeFileSummary>();
  for (let i = 0; i < pieces.length - 1; i += 2) {
    const file = pieces[i + 1];
    if (!file) continue;
    files.set(file, {
      id: fileId(file),
      path: file,
      status: pieces[i],
      conflicted: conflicts.has(file),
    });
  }
  for (const file of conflicts)
    files.set(file, {
      id: fileId(file),
      path: file,
      status: "U",
      conflicted: true,
    });
  return [...files.values()].sort(
    (a, b) =>
      Number(b.conflicted) - Number(a.conflicted) ||
      a.path.localeCompare(b.path),
  );
}
async function blob(
  mr: MergeRequest,
  oid: string | undefined,
): Promise<string> {
  if (!oid) return "";
  const size = Number((await git(mr, ["cat-file", "-s", oid])).stdout.trim());
  if (size > MAX_FILE_BYTES)
    throw new GitMrError(
      "File exceeds the 2 MB editable limit. Choose a complete side instead.",
      "FILE_TOO_LARGE",
    );
  return (await git(mr, ["cat-file", "blob", oid])).stdout;
}
async function treeEntry(mr: MergeRequest, oid: string, file: string) {
  const value = (await git(mr, ["ls-tree", "-z", oid, "--", file])).stdout;
  if (!value) return undefined;
  const [mode, , object] = value.slice(0, value.indexOf("\t")).split(" ");
  return { mode, oid: object };
}
export async function readFile(
  mr: MergeRequest,
  id: string,
): Promise<MergeFile> {
  const summary = (await listFiles(mr)).find((file) => file.id === id);
  if (!summary || !mr.worktree)
    throw new GitMrError(
      "File not found in this merge request.",
      "NOT_FOUND",
      404,
    );
  const matches = (await entries(mr)).filter(
    (entry) => entry.path === summary.path,
  );
  const step = mr.steps[mr.currentStep] ?? mr.steps.at(-1);
  const baseEntry = matches.find((entry) => entry.stage === 1);
  const targetEntry = summary.conflicted
    ? matches.find((entry) => entry.stage === 2)
    : await treeEntry(mr, mr.targetOid, summary.path);
  const sourceEntry = summary.conflicted
    ? matches.find((entry) => entry.stage === 3)
    : step
      ? await treeEntry(mr, step.oid, summary.path)
      : undefined;
  const filename = await safeWorktreeFile(mr, mr.worktree, summary.path);
  const stat = await fs.lstat(filename).catch(() => null);
  let buffer = Buffer.alloc(0);
  let reason: string | undefined;
  if (stat?.isSymbolicLink()) buffer = Buffer.from(await fs.readlink(filename));
  else if (stat?.isFile() && stat.size <= MAX_FILE_BYTES)
    buffer = await fs.readFile(filename);
  else if (stat)
    reason = stat.isDirectory()
      ? "Submodule or directory conflict needs a Git-aware external resolver."
      : "File exceeds the 2 MB editable limit.";
  const values: string[] = [];
  for (const entry of [baseEntry, targetEntry, sourceEntry]) {
    if (entry?.mode === "160000") {
      values.push(entry.oid);
      reason =
        "Submodule conflicts require an explicit gitlink decision outside the text editor.";
      continue;
    }
    try {
      values.push(await blob(mr, entry?.oid));
    } catch (error) {
      if (error instanceof GitMrError && error.code === "FILE_TOO_LARGE") {
        values.push("");
        reason = error.message;
      } else throw error;
    }
  }
  let resultDigest = digest(buffer);
  if (stat?.isFile() && stat.size > MAX_FILE_BYTES) {
    const hasher = createHash("sha256");
    for await (const chunk of createReadStream(filename)) hasher.update(chunk);
    resultDigest = hasher.digest("hex");
  }
  const result = buffer.toString("utf8");
  const binary =
    [...values, result].some(
      (value) => value.includes("\0") || value.includes("\ufffd"),
    ) || !Buffer.from(result).equals(buffer);
  const structural =
    matches.some(
      (entry) => entry.mode === "120000" || entry.mode === "160000",
    ) ||
    (summary.conflicted && (!targetEntry || !sourceEntry));
  return {
    ...summary,
    kind: structural ? "structural" : binary || reason ? "binary" : "text",
    base: values[0],
    target: values[1],
    source: values[2],
    result,
    revision: digest(
      JSON.stringify({
        entries: matches,
        target: mr.targetOid,
        current: mr.currentStep,
        result: resultDigest,
        size: stat?.size,
        reason,
      }),
    ),
    baseExists: !!baseEntry,
    targetExists: !!targetEntry,
    sourceExists: !!sourceEntry,
    reason,
  };
}
export async function writeFile(
  mr: MergeRequest,
  id: string,
  input: MergeFileSave,
) {
  if (mr.status !== "conflicted" || !mr.worktree)
    throw new GitMrError(
      "Only an active conflict can be edited.",
      "INVALID_STATE",
    );
  const file = await readFile(mr, id);
  if (!file.conflicted)
    throw new GitMrError("This file is already resolved.", "INVALID_STATE");
  if (file.revision !== input.expectedRevision)
    throw new GitMrError(
      "The file changed. Reload before applying this decision.",
      "STALE_DRAFT",
    );
  if (file.reason?.startsWith("Submodule"))
    throw new GitMrError(file.reason, "UNSUPPORTED_CONFLICT");
  const destination = await safeWorktreeFile(mr, mr.worktree, file.path);
  if (input.choice) {
    if (!input.resolve)
      throw new GitMrError(
        "Whole-file decisions must explicitly resolve the file.",
        "INVALID_INPUT",
        400,
      );
    const stage = input.choice === "target" ? 2 : 3;
    const exists =
      input.choice === "target" ? file.targetExists : file.sourceExists;
    if (input.choice === "delete" || !exists)
      await git(mr, ["rm", "-f", "--", file.path], { cwd: mr.worktree });
    else {
      await git(
        mr,
        ["checkout-index", `--stage=${stage}`, "--force", "--", file.path],
        { cwd: mr.worktree },
      );
      await git(mr, ["add", "--", file.path], { cwd: mr.worktree });
    }
  } else {
    if (file.kind !== "text")
      throw new GitMrError(
        "This file cannot be edited as text. Select a complete version.",
        "UNSUPPORTED_CONFLICT",
      );
    if (
      typeof input.content !== "string" ||
      Buffer.byteLength(input.content) > MAX_FILE_BYTES
    )
      throw new GitMrError(
        "Invalid or oversized file content.",
        "INVALID_INPUT",
        400,
      );
    if (input.resolve && /^(<{7}|\|{7}|={7}|>{7})(?:\s|$)/m.test(input.content))
      throw new GitMrError(
        "Resolve every conflict marker before marking this file resolved.",
        "UNRESOLVED_CONTENT",
      );
    const stat = await fs.lstat(destination).catch(() => null);
    if (stat?.isSymbolicLink())
      throw new GitMrError(
        "Cannot write through a symbolic link.",
        "UNSAFE_PATH",
      );
    // Preserve the file mode and EOL bytes; never normalize or truncate result text.
    await fs.writeFile(destination, input.content, "utf8");
    if (input.resolve)
      await git(mr, ["add", "--", file.path], { cwd: mr.worktree });
  }
  return file;
}
