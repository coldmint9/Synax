import fs from "node:fs";
import path from "node:path";
import { isWithinWorkspace } from "../project-workspace.js";
import { AgentValidationError } from "./runtime-errors.js";

/**
 * Workspace-relative path guard shared by the environment file APIs and the
 * workspace Git reader. Keeping it in its own module lets both sides validate
 * paths without importing each other.
 */
export function assertRelativePath(relativePath: string): string {
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

export function resolveSafeFile(
  workspacePath: string,
  relativePath: string,
): string {
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
