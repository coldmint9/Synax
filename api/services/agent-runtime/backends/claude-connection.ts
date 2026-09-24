import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Options, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import {
  spawnManagedProcess,
  type ManagedProcess,
} from "../managed-process.js";

export const CLAUDE_SDK_VERSION = "0.3.220";
const credentialKeys = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_API_KEY",
];
const cliEnv =
  /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|DEFAULT_[A-Z_]+_MODEL(_NAME)?)|CLAUDE_CODE_(SUBAGENT_MODEL|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY))$/;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Only native API/model settings are inherited; executable helpers, hooks and tool configuration are not. */
export function claudeEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
) {
  const settingsPath = path.join(home, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath))
    settings = record(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  const env: NodeJS.ProcessEnv = { ...base };
  const importedKeys: string[] = [];
  for (const [key, value] of Object.entries(record(settings.env))) {
    if (cliEnv.test(key) && !env[key] && typeof value === "string") {
      env[key] = value;
      importedKeys.push(key);
    }
  }
  // SDK integrations must not silently consume a user's claude.ai subscription credentials.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  delete env.CLAUDECODE;
  const cloud = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ].find((key) => /^(1|true)$/.test(env[key] ?? ""));
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN && !cloud) {
    throw new Error(
      "Claude Agent SDK requires an API key, API gateway token, or supported cloud authentication. A claude.ai subscription login is not used by Synax.",
    );
  }
  if (
    [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].some((value) =>
      value?.startsWith("sk-ant-oat"),
    )
  )
    throw new Error(
      "Claude subscription OAuth tokens are not supported by this SDK integration.",
    );
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "synax/1.0.4";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  const model =
    env.ANTHROPIC_MODEL ||
    (typeof settings.model === "string" ? settings.model : undefined);
  const redact = (error: unknown) => {
    let message = error instanceof Error ? error.message : String(error);
    for (const key of credentialKeys) {
      const secret = env[key];
      if (secret) message = message.split(secret).join("[redacted]");
    }
    return message;
  };
  return {
    env,
    model,
    redact,
    auth: {
      kind: cloud ?? (env.ANTHROPIC_API_KEY ? "api-key" : "api-gateway-token"),
      source: importedKeys.some((key) => credentialKeys.includes(key))
        ? "user-settings-env"
        : "runtime-environment",
      importedKeys,
    },
  };
}

export function claudeExecutable(env: NodeJS.ProcessEnv): string {
  const names =
    process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const directory of (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean))
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* Try the next PATH entry. */
      }
    }
  throw new Error(
    "Claude Code CLI was not found on PATH. Install the native CLI before selecting this backend.",
  );
}

export function claudeOptions(
  workDir: string,
  onProcess: (process: ManagedProcess) => void,
  context = claudeEnvironment(),
): { options: Options; context: typeof context } {
  const options: Options = {
    cwd: workDir,
    env: context.env,
    pathToClaudeCodeExecutable: claudeExecutable(context.env),
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    skills: [],
    permissionMode: "default",
    allowDangerouslySkipPermissions: false,
    disallowedTools: [
      "CronCreate",
      "CronDelete",
      "CronList",
      "ScheduleWakeup",
      "EnterWorktree",
      "ExitWorktree",
    ],
    systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    settings: {
      disableAllHooks: true,
      disableBundledSkills: true,
      autoMemoryEnabled: false,
      permissions: { defaultMode: "default" },
    },
    extraArgs: { "disable-slash-commands": null },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: { allowWrite: [workDir] },
      credentials: {
        envVars: credentialKeys
          .filter((key) => context.env[key])
          .map((name) => ({ name, mode: "deny" as const })),
      },
    },
    spawnClaudeCodeProcess(spawn): SpawnedProcess {
      const managed = spawnManagedProcess(spawn.command, spawn.args, {
        cwd: spawn.cwd,
        env: spawn.env,
        inheritEnv: false,
      });
      onProcess(managed);
      const stop = () => {
        void managed.stop().catch(() => {});
      };
      spawn.signal.addEventListener("abort", stop, { once: true });
      if (spawn.signal.aborted) stop();
      void managed.closed.then(() =>
        spawn.signal.removeEventListener("abort", stop),
      );
      const child = managed.child;
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        get killed() {
          return child.killed;
        },
        get exitCode() {
          return child.exitCode;
        },
        get signalCode() {
          return child.signalCode;
        },
        kill() {
          stop();
          return true;
        },
        on: child.on.bind(child),
        once: child.once.bind(child),
        off: child.off.bind(child),
      };
    },
  };
  return { options, context };
}
