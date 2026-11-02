import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import type { RegisteredTool } from "../contracts.js";
import {
  clearSessionFileRead,
  compareSessionFileRead,
  recordSessionFileDiscovery,
  recordSessionFileMutation,
} from "../read-tracker.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "./workspace.js";
import { invalidPatchDiagnostic, PatchApplyError } from "./patch-diagnostics.js";
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
  const claim = (filePath: string, resolvedPath: string): void => {
    const key = path.normalize(resolvedPath);
    if (claimed.has(key))
      throw new PatchApplyError({
        ...invalidPatchDiagnostic(`Patch touches ${filePath} more than once.`, "Use one Update File header per path with ordered, non-overlapping hunks; do not retry unchanged."),
        path: filePath,
      });
    claimed.add(key);
  };

  for (const hunk of hunks) {
    const source = resolveWorkspacePath(hunk.path, sessionId);
    claim(hunk.path, source);

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
      target = resolveWorkspacePath(movePath, sessionId);
      claim(movePath, target);
      if (fs.existsSync(target))
        throw new Error(`Move target already exists: ${movePath}`);
    }
    const current = fs.readFileSync(source);
    let contents = current.toString("utf8");
    try {
      if (hunk.chunks.length > 0)
        contents = deriveNewContentsFromChunks(hunk.path, hunk.chunks, contents);
    } catch (error) {
      if (error instanceof PatchApplyError) {
        throw new PatchApplyError({
          ...error.diagnostic,
          readBaseline: compareSessionFileRead(sessionId, hunk.path, current),
        });
      }
      throw error;
    }
    changes.push({
      action: "update",
      sourcePath: hunk.path,
      targetPath: movePath ?? hunk.path,
      source,
      target,
      contents,
    });
  }
  return changes;
}

export const patchTool: RegisteredTool = {
  id: "file.patch",
  label: "Apply Patch",
  description:
    "Apply one *** Begin Patch / *** End Patch envelope that may add, update, move, or delete one or more files in a single call.",
  category: "write",
  internalGate: "write",
  mutability: "write",
  resumeBehavior: "wait_permission",
  progressiveDetails:
    "Accepts { patch: string }. Supports *** Add File, *** Update File (with @@ hunks and optional *** Move to) and *** Delete File. Every hunk is matched against current content before anything is written; a mismatch aborts the whole patch. Use concrete file paths in the envelope, relative to the session working directory or absolute paths permitted by the sandbox. All hunks use the pre-edit file, not earlier hunk results. Order hunks by original position with non-overlapping context; merge adjacent edits. Use one Update File header per path. Bare @@ starts a hunk; @@ exact source line anchors it and the search starts AFTER that line, so do not repeat it in the hunk; if that line repeats, the hunk body decides which occurrence applies. Unified-diff line-number headers are not supported. Prefix context/deleted/added lines with space/-/+ (including blank lines). Addition-only hunks append unless anchored; anchored additions insert immediately after the anchor. *** End of File requires the hunk to end at EOF. Use enough exact current context to uniquely locate the edit; do not copy truncated search previews. On failure nothing was applied: read the suggested range with file.read, rebuild from current text, and do not retry the same patch unchanged or fall back to whole-file overwrite. Include a final *** End Patch marker and place *** Move to immediately after *** Update File when moving a file.",
  inputSchema: z.object({
    patch: z
      .string()
      .min(1)
      .describe("Full *** Begin Patch / *** End Patch envelope. Ordered, non-overlapping hunks against the pre-edit file; use @@ or @@ exact source anchor, not unified-diff line numbers."),
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
      recordSessionFileDiscovery(input.sessionId, change.targetPath);
      // Keep the post-write snapshot current for other tools that use the read tracker.
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
