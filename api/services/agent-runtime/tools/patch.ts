import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import type { RegisteredTool } from "../contracts.js";
import {
  assertSessionFileReadForWrite,
  clearSessionFileRead,
  recordSessionFileMutation,
} from "../read-tracker.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "./workspace.js";
import {
  deriveNewContentsFromChunks,
  parseApplyPatchEnvelope,
  type PatchHunk,
} from "./patch-format.js";

interface PlannedChange {
  action: "add" | "update" | "delete";
  /** Path named by the patch, workspace-relative. */
  sourcePath: string;
  /** Where the result lands; equals sourcePath unless the hunk moves the file. */
  targetPath: string;
  source: string;
  target: string;
  contents?: string;
}

/**
 * Match every hunk against the current files before touching disk, so a patch
 * with one stale hunk leaves the workspace untouched instead of half-applied.
 */
function planChanges(sessionId: string, hunks: PatchHunk[]): PlannedChange[] {
  const claimed = new Set<string>();
  const changes: PlannedChange[] = [];
  const claim = (filePath: string): void => {
    const key = path.normalize(filePath.replace(/\\/g, "/"));
    if (claimed.has(key))
      throw new Error(`Patch touches ${filePath} more than once.`);
    claimed.add(key);
  };

  for (const hunk of hunks) {
    claim(hunk.path);
    const source = resolveWorkspacePath(hunk.path, sessionId);
    assertSessionFileReadForWrite(sessionId, hunk.path);

    if (hunk.type === "add") {
      if (fs.existsSync(source))
        throw new Error(`Add File target already exists: ${hunk.path}`);
      changes.push({
        action: "add",
        sourcePath: hunk.path,
        targetPath: hunk.path,
        source,
        target: source,
        contents: hunk.contents.endsWith("\n")
          ? hunk.contents
          : `${hunk.contents}\n`,
      });
      continue;
    }

    if (hunk.type === "delete") {
      if (!fs.existsSync(source))
        throw new Error(`Delete File target not found: ${hunk.path}`);
      changes.push({
        action: "delete",
        sourcePath: hunk.path,
        targetPath: hunk.path,
        source,
        target: source,
      });
      continue;
    }

    const movePath =
      hunk.movePath && hunk.movePath !== hunk.path ? hunk.movePath : undefined;
    if (hunk.chunks.length === 0 && !movePath)
      throw new Error(`Update File has no hunks: ${hunk.path}`);
    let target = source;
    if (movePath) {
      claim(movePath);
      target = resolveWorkspacePath(movePath, sessionId);
      if (fs.existsSync(target))
        throw new Error(`Move target already exists: ${movePath}`);
      assertSessionFileReadForWrite(sessionId, movePath);
    }
    const current = fs.readFileSync(source, "utf8");
    changes.push({
      action: "update",
      sourcePath: hunk.path,
      targetPath: movePath ?? hunk.path,
      source,
      target,
      contents:
        hunk.chunks.length > 0
          ? deriveNewContentsFromChunks(hunk.path, hunk.chunks, current)
          : current,
    });
  }
  return changes;
}

export const patchTool: RegisteredTool = {
  id: "file.patch",
  label: "Apply Patch",
  description:
    "Apply one *** Begin Patch / *** End Patch envelope that may add, update, move, or delete several files in a single call. Read each file first. Prefer edit for a change confined to one file.",
  category: "write",
  internalGate: "write",
  mutability: "write",
  resumeBehavior: "wait_permission",
  progressiveDetails:
    "Accepts { patch: string }. Supports *** Add File, *** Update File (with @@ hunks and optional *** Move to) and *** Delete File. Every hunk is matched against current content before anything is written; a mismatch aborts the whole patch.",
  inputSchema: z.object({
    patch: z
      .string()
      .min(1)
      .describe("Full *** Begin Patch / *** End Patch envelope."),
  }),
  execute(input) {
    const args = input.args as { patch?: string };
    if (typeof args?.patch !== "string" || !args.patch.trim())
      throw new Error("patch is required.");

    const hunks = parseApplyPatchEnvelope(args.patch);
    if (hunks.length === 0)
      throw new Error("patch contains no file operations.");
    const changes = planChanges(input.sessionId, hunks);

    let bytes = 0;
    let deletes = 0;
    for (const change of changes) {
      if (change.action === "delete") {
        fs.rmSync(change.target, { force: true });
        clearSessionFileRead(input.sessionId, change.targetPath);
        deletes += 1;
        continue;
      }
      fs.mkdirSync(path.dirname(change.target), { recursive: true });
      fs.writeFileSync(change.target, change.contents ?? "", "utf8");
      bytes += Buffer.byteLength(change.contents ?? "", "utf8");
      // Refresh the tracked mtime: this write satisfies the read-before-write
      // guard for follow-up edits of the same file.
      recordSessionFileMutation(
        input.sessionId,
        change.targetPath,
        change.contents,
      );
      if (change.target !== change.source) {
        fs.rmSync(change.source, { force: true });
        clearSessionFileRead(input.sessionId, change.sourcePath);
        deletes += 1;
      }
    }

    const files = changes.map((change) => ({
      path: toWorkspaceRelative(change.source, input.sessionId),
      action: change.action,
      ...(change.target !== change.source
        ? {
            movePath: toWorkspaceRelative(change.target, input.sessionId),
          }
        : {}),
    }));
    const names = files.map((file) => file.path);
    const summary = `Patched ${names.length} file${names.length === 1 ? "" : "s"}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3} more` : ""}.`;
    return {
      result: { files, bytes },
      displaySummary: summary,
      artifacts: [
        {
          kind: "decision",
          title: "File patch",
          summary,
          risk: deletes > 0 ? "high" : "medium",
        },
      ],
    };
  },
};
