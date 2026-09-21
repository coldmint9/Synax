import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerConfig } from "../../lib/config/config-types.js";

function baseEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ) as Record<string, string>;
}

function expandConfigValue(
  value: string,
  cwd: string,
  env: Record<string, string>,
): string {
  return value
    .replace(/\$\{(?:workspaceFolder|workspaceRoot)\}/g, cwd)
    .replace(/\$\{userHome\}/g, os.homedir())
    .replace(
      /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (match, name: string) => env[name] ?? match,
    )
    .replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (match, name: string) => env[name] ?? match,
    )
    .replace(
      /\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match, name: string) => env[name] ?? match,
    )
    .replace(
      /%([A-Za-z_][A-Za-z0-9_]*)%/g,
      (match, name: string) => env[name] ?? match,
    );
}

/** MCP cwd is explicit/project-scoped, never the API's app Resources directory. */
export function mcpLaunchConfig(config: McpServerConfig, workspaceDirectory?: string) {
  const inheritedEnv = baseEnv();
  const base = workspaceDirectory ?? os.homedir();
  const rawCwd = expandConfigValue(config.cwd ?? base, base, inheritedEnv);
  const expandedCwd = rawCwd === "~" ? os.homedir()
    : rawCwd.startsWith("~/") ? path.join(os.homedir(), rawCwd.slice(2)) : rawCwd;
  let cwd: string;
  try {
    cwd = fs.realpathSync(path.resolve(base, expandedCwd));
    if (!fs.statSync(cwd).isDirectory()) throw new Error("Not a directory");
  } catch {
    throw new Error(`MCP working directory is unavailable: ${expandedCwd}`);
  }
  const workspace = workspaceDirectory ?? cwd;
  const configuredEnv = Object.fromEntries(
    Object.entries(config.env ?? {}).map(([name, value]) => [
      name, expandConfigValue(value, workspace, inheritedEnv),
    ]),
  );
  const env = { ...inheritedEnv, ...configuredEnv };
  let command = expandConfigValue(config.command, workspace, env);
  if (!path.isAbsolute(command) && /[\\/]/.test(command)) {
    if (!config.cwd && !workspaceDirectory)
      throw new Error("A relative MCP executable requires an explicit cwd or project workspace.");
    command = path.resolve(cwd, command);
    try {
      if (!fs.statSync(command).isFile()) throw new Error("Not a file");
      fs.accessSync(command, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    } catch {
      throw new Error(`MCP executable is unavailable: ${command} (cwd: ${cwd}). Set an absolute command or correct cwd.`);
    }
  }
  return {
    command,
    args: (config.args ?? []).map(value => expandConfigValue(value, workspace, env)),
    ...(config.env && Object.keys(config.env).length > 0 ? { env } : {}),
    cwd,
  };
}
