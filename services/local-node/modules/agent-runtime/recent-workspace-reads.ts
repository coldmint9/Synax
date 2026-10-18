import fs from "node:fs";
import path from "node:path";
import { agentRuntimeStore } from "./session-store.js";
import { extractBashReadPaths } from "./read-tracker.js";
import { resolveProjectWorkspaceLocation } from "./tools/workspace.js";
import { isWithinWorkspace } from "../project-workspace.js";
import { workspaceLocationHostPath, type WorkspaceLocation } from "../workspace-location.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Suggestions use only reachable records in the Rust-backed working set. */
export function recentWorkspaceReadPaths(roots: string[]): string[] {
  const rows = agentRuntimeStore.listSessions({ limit: Number.MAX_SAFE_INTEGER })
    .flatMap((session) => agentRuntimeStore.listToolCalls(session.id)
      .filter((tool) => tool.status === "completed" && (
        /(?:^|\.)read$|read_file$|read_text_file$/i.test(tool.toolId) ||
        /bash$|commandExecution$/i.test(tool.toolId)
      ))
      .map((tool) => ({ tool, session })))
    .sort((a, b) => (b.tool.endedAt ?? b.tool.startedAt).localeCompare(a.tool.endedAt ?? a.tool.startedAt))
    .slice(0, 2000);
  const seen = new Set<string>();
  const checked = new Set<string>();
  const projectLocations = new Map<string, WorkspaceLocation | undefined>();
  for (const { tool, session } of rows) {
    const raw = object(tool.inputRef);
    const input = object(raw.nativeTool ?? raw);
    const output = object(tool.outputRef);
    let paths: string[];
    if (/bash$|commandExecution$/i.test(tool.toolId)) {
      const command = input.command;
      const exitCode = output.exitCode ?? output.exit_code;
      if (typeof command !== "string" || (exitCode != null && exitCode !== 0) || (tool.toolId === "bash" && exitCode == null)) continue;
      paths = extractBashReadPaths(command);
    } else {
      const file = input.path ?? input.file_path ?? input.filePath;
      paths = typeof file === "string" ? [file] : [];
    }
    if (!paths.length) continue;
    const backend = session.sessionMetadata?.backend as { workDir?: string; workspaceLocation?: WorkspaceLocation } | undefined;
    if (!backend?.workDir && !backend?.workspaceLocation && !projectLocations.has(session.projectId))
      projectLocations.set(session.projectId, resolveProjectWorkspaceLocation(session.projectId));
    const location = backend?.workspaceLocation ?? projectLocations.get(session.projectId);
    const root = backend?.workDir ?? (location && workspaceLocationHostPath(location));
    for (const file of paths) {
      if (!path.isAbsolute(file) && !root) continue;
      const absolute = path.resolve(root ?? path.parse(file).root, file);
      if (checked.has(absolute)) continue;
      checked.add(absolute);
      try {
        const real = fs.realpathSync(absolute);
        if (roots.some((dir) => isWithinWorkspace(dir, real)) && fs.statSync(real).isFile()) seen.add(real);
      } catch {
        // Missing historical files never become suggestions.
      }
    }
  }
  return [...seen];
}
