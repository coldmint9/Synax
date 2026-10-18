import fs from "node:fs";
import path from "node:path";
import { runtimeFacade } from "./sidecar/runtime-facade.js";
import type { AgentSession,ToolCallRecord } from "./contracts.js";
import { extractBashReadPaths } from "./read-tracker.js";
import { resolveProjectWorkspaceLocation } from "./tools/workspace.js";
import { isWithinWorkspace } from "../project-workspace.js";
import {
  workspaceLocationHostPath,
  type WorkspaceLocation,
} from "../workspace-location.js";

interface ReadRow {
  tool_id: string;
  input_ref_json: string | null;
  output_ref_json: string | null;
  project_id: string;
  session_metadata_json: string | null;
}
function object(json: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Durable history works across sessions, server restarts and runtime workers. */
export async function recentWorkspaceReadPaths(roots: string[]): Promise<string[]> {
  const sessions=await runtimeFacade.listSessionProjection() as AgentSession[];
  const rows:ReadRow[]=[];
  for(const session of sessions.filter(s=>!s.sessionMetadata?.archivedAt && !s.sessionMetadata?.deletedAt).slice(0,50)) {
    const calls=await runtimeFacade.listHistoryObjects(session.id,'list_tool_calls') as ToolCallRecord[];
    for(const call of calls.filter(t=>t.status==='completed').slice(-200)) rows.push({tool_id:call.toolId,input_ref_json:JSON.stringify(call.inputRef),output_ref_json:JSON.stringify(call.outputRef),project_id:session.projectId,session_metadata_json:JSON.stringify(session.sessionMetadata)});
  }
  const seen = new Set<string>();
  const checked = new Set<string>();
  const projectLocations = new Map<string, WorkspaceLocation | undefined>();
  for (const row of rows) {
    const raw = object(row.input_ref_json);
    const input =
      raw.nativeTool && typeof raw.nativeTool === "object"
        ? (raw.nativeTool as Record<string, unknown>)
        : raw;
    const output = object(row.output_ref_json);
    let paths: string[];
    if (/bash$|commandExecution$/i.test(row.tool_id)) {
      const command = input.command;
      const exitCode = output.exitCode ?? output.exit_code;
      if (
        typeof command !== "string" ||
        (exitCode != null && exitCode !== 0) ||
        (row.tool_id === "bash" && exitCode == null)
      )
        continue;
      paths = extractBashReadPaths(command);
    } else {
      const file = input.path ?? input.file_path ?? input.filePath;
      paths = typeof file === "string" ? [file] : [];
    }
    if (!paths.length) continue;
    const metadata = object(row.session_metadata_json);
    const backend = metadata.backend as
      | {
          workDir?: string;
          workspaceLocation?: WorkspaceLocation;
        }
      | undefined;
    if (
      !backend?.workDir &&
      !backend?.workspaceLocation &&
      !projectLocations.has(row.project_id)
    ) {
      projectLocations.set(
        row.project_id,
        resolveProjectWorkspaceLocation(row.project_id),
      );
    }
    const location =
      backend?.workspaceLocation ?? projectLocations.get(row.project_id);
    const root =
      backend?.workDir ?? (location && workspaceLocationHostPath(location));
    for (const file of paths) {
      if (!path.isAbsolute(file) && !root) continue;
      const absolute = path.resolve(root ?? path.parse(file).root, file);
      if (checked.has(absolute)) continue;
      checked.add(absolute);
      try {
        const real = fs.realpathSync(absolute);
        if (
          roots.some((dir) => isWithinWorkspace(dir, real)) &&
          fs.statSync(real).isFile()
        )
          seen.add(real);
      } catch {
        // Missing historical files never become suggestions.
      }
    }
  }
  return [...seen];
}
