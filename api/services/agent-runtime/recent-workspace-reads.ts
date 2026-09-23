import fs from "node:fs";
import path from "node:path";
import { getRawSqlite } from "../../db/index.js";
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
export function recentWorkspaceReadPaths(roots: string[]): string[] {
  const rows = getRawSqlite()
    .prepare(
      `
    SELECT t.tool_id, t.input_ref_json,
           CASE WHEN json_valid(t.output_ref_json) THEN json_object('exitCode',
             COALESCE(json_extract(t.output_ref_json, '$.exitCode'),
                      json_extract(t.output_ref_json, '$.exit_code')))
           ELSE NULL END AS output_ref_json,
           s.project_id, s.session_metadata_json
    FROM agent_runtime_tool_calls t
    JOIN agent_runtime_sessions s ON s.id = t.session_id
    WHERE s.archived_at IS NULL AND t.status = 'completed' AND (
      t.tool_id = 'file.read' OR lower(t.tool_id) GLOB '*.read'
      OR lower(t.tool_id) GLOB '*read_file' OR lower(t.tool_id) GLOB '*read_text_file'
      OR t.tool_id = 'bash' OR lower(t.tool_id) GLOB '*.bash'
      OR t.tool_id = 'codex.commandExecution'
    )
    ORDER BY t.ended_at DESC, t.rowid DESC LIMIT 2000
  `,
    )
    .all() as unknown as ReadRow[];
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
