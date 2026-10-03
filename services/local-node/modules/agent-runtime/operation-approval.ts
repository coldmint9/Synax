import fs from "node:fs";
import path from "node:path";
import type { PermissionRequestInput } from "./permission-policy.js";
import { grantedToolId } from "./project-tool-grants.js";
import type { InternalGate, PermissionAction } from "./contracts.js";
import { permissionTierFromRules } from "./permission-tiers.js";
import {
  sandboxPolicy,
  SandboxViolationError,
  PATH_EXTRACTORS,
  sandboxConfigForSession,
} from "./sandbox/index.js";
import { workspaceRoot } from "./tools/workspace.js";

export interface OperationReview {
  action: PermissionAction;
  reason: string;
  paths: string[];
  gate?: InternalGate;
}

const LOCAL_READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "ls",
  "wc",
  "grep",
  "rg",
  "echo",
  "printf",
  "pwd",
  "id",
  "uname",
  "basename",
  "dirname",
  "realpath",
]);
const SENSITIVE_PATH =
  /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|\.git|\.env(?:\.[^\\/]*)?|credentials?)(?:[\\/]|$)|\.(?:key|pem|p12|pfx)$/i;

function isPublicSystemFile(target: string): boolean {
  const roots = [
    "/usr/share",
    "/usr/include",
    "/System/Library",
    "/Library/Developer/CommandLineTools/SDKs",
    "/etc/hosts",
    "/private/etc/hosts",
  ];
  if (
    !roots.some((root) => target === root || target.startsWith(root + path.sep))
  )
    return false;
  try {
    const file = fs.statSync(target);
    if (!file.isFile() || file.uid !== 0 || !(file.mode & 0o004)) return false;
    for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
      if (!(fs.statSync(dir).mode & 0o001)) return false;
      if (dir === path.dirname(dir)) return true;
    }
  } catch {
    return false;
  }
}

function workspaceExecutable(
  command: string,
  cwd: string,
  sessionId: string,
): string | null {
  const roots = [
    workspaceRoot(sessionId),
    ...(sandboxConfigForSession(sessionId).workspaceRoots ?? []),
  ].map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return path.resolve(root);
    }
  });
  const directories = (process.env.PATH ?? "").split(path.delimiter);
  const names =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((ext) => command + ext)
      : [command];
  if (process.platform === "win32") directories.unshift(cwd);
  for (const directory of directories)
    for (const name of names) {
      try {
        const candidate = path.resolve(cwd, directory || ".", name);
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        const real = fs.realpathSync(candidate);
        return roots.some(
          (root) => real === root || real.startsWith(root + path.sep),
        )
          ? real
          : null;
      } catch {
        /* Continue the executable search, as the shell does. */
      }
    }
  return null;
}

/** ponytail: conservative static review; unknown syntax/commands stay manual, not guessed safe. */
export function reviewOperation(
  input: PermissionRequestInput,
): OperationReview | null {
  const mode = permissionTierFromRules(input.rules ?? []);
  if (!mode || mode === "unrestricted" || grantedToolId(input)) return null;
  const toolId =
    typeof input.metadata?.toolId === "string" ? input.metadata.toolId : "";
  const args = (input.metadata?.args ?? {}) as Record<string, unknown>;
  const command =
    typeof input.metadata?.command === "string"
      ? input.metadata.command
      : typeof args.command === "string"
        ? args.command
        : null;
  const shell = input.internalGate === "shell" || input.category === "shell";
  const tokens = command?.trim().split(/\s+/) ?? [];
  const paths = new Set<string>();
  let external = input.internalGate === "external_path";
  let sensitive = false;
  const request = (reason: string, gate?: InternalGate): OperationReview => ({
    action: "ask",
    reason,
    paths: [...paths],
    gate,
  });
  if (input.metadata?.source === "acp")
    return request(
      "The native operation's filesystem and network scope cannot be verified automatically.",
    );
  if (input.category === "high_risk" || input.category === "external_execution")
    return request(
      "High-risk or externally executed operations require explicit approval.",
    );
  const candidates =
    PATH_EXTRACTORS[toolId]?.(args) ??
    (typeof args.path === "string" ? [args.path] : []);
  // Even extensionless shell operands can be symlinks to external files.
  if (shell)
    candidates.push(
      ...tokens
        .slice(1)
        .filter((token) => !token.startsWith("-"))
        .map((token) => token.replace(/^['"]|['"]$/g, "")),
    );
  for (const candidate of candidates) {
    if (typeof candidate !== "string")
      return request("Invalid or unknown file scope requires approval.");
    try {
      const resolved = sandboxPolicy.resolve(
        candidate,
        workspaceRoot(input.sessionId),
        input.sessionId,
        toolId,
      );
      sensitive ||= SENSITIVE_PATH.test(resolved);
    } catch (error) {
      if (!(error instanceof SandboxViolationError))
        return request("The file scope could not be verified.");
      if (error.violation.kind === "null_byte")
        return { action: "deny", reason: error.message, paths: [] };
      if (error.violation.resolvedPath) paths.add(error.violation.resolvedPath);
      external ||=
        error.violation.kind === "boundary_escape" ||
        error.violation.kind === "symlink_escape";
      sensitive ||=
        SENSITIVE_PATH.test(error.violation.resolvedPath ?? candidate) ||
        error.violation.kind === "blocked_extension";
    }
  }
  if (
    external &&
    mode === "auto" &&
    toolId === "file.read" &&
    !sensitive &&
    paths.size > 0 &&
    [...paths].every(isPublicSystemFile)
  ) {
    return {
      action: "allow",
      reason:
        "Automatic review: read-only access to a public, root-owned system reference file.",
      paths: [...paths],
      gate: "external_path",
    };
  }
  if (external)
    return request(
      "Access outside the workspace requires approval for this operation.",
      "external_path",
    );
  if (sensitive)
    return request(
      "This operation may access credentials or repository control files. Confirm it explicitly.",
    );
  if (input.internalGate === "delete")
    return request("Deleting files requires explicit approval.");
  const browserInteraction =
    toolId.startsWith("browser.") &&
    ![
      "browser.snapshot",
      "browser.screenshot",
      "browser.console",
      "browser.network",
      "browser.close",
    ].includes(toolId);
  const network =
    input.internalGate === "network" ||
    toolId === "webSearch" ||
    browserInteraction ||
    input.category === "mcp";
  if (network && (mode === "boundary" || toolId !== "webSearch"))
    return request(
      "Network access requires approval for this operation.",
      "network",
    );
  if (shell) {
    const simple =
      command !== null &&
      /^[\p{L}\p{N}\s_./:-]+$/u.test(command) &&
      !/[\r\n]/.test(command);
    const unsafeOption = tokens.some((token) =>
      /^(?:--pre(?:-glob)?|--follow|--files-from|--no-ignore|-L|-R)$/.test(
        token,
      ),
    );
    const cwd =
      typeof args.workdir === "string"
        ? path.resolve(workspaceRoot(input.sessionId), args.workdir)
        : workspaceRoot(input.sessionId);
    const shadow =
      simple && LOCAL_READ_COMMANDS.has(tokens[0])
        ? workspaceExecutable(tokens[0], cwd, input.sessionId)
        : null;
    if (shadow)
      return request(
        `This command resolves to workspace executable ${shadow}. Confirm before executing project code.`,
        "shell",
      );
    if (!simple || !LOCAL_READ_COMMANDS.has(tokens[0]) || unsafeOption)
      return request(
        "The command may modify files, access the network, or execute other code. Confirm it explicitly.",
        "shell",
      );
  }
  return null;
}
