import os from "node:os";
import path from "node:path";

export type DevProfileTarget = "client" | "desktop";

export interface DevProfileOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the defaults for an isolated development profile.
 * Explicit environment variables always win so CI and local custom setups
 * can still select their own data root and ports.
 */
export function resolveDevProfileEnvironment(
  profile: string,
  target: DevProfileTarget,
  options: DevProfileOptions = {},
): Record<string, string> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const defaultLocalPort = target === "client" ? "3211" : undefined;
  const defaultClientPort = target === "client" ? "5174" : "5173";

  const resolved: Record<string, string> = {
    SYNAX_PROFILE: profile,
    DATA_ROOT: env.DATA_ROOT ?? path.join(homeDir, ".synax", profile),
    WEB_PORT: env.WEB_PORT ?? defaultClientPort,
  };

  if (target === "client" || env.PORT) {
    resolved.PORT = env.PORT ?? defaultLocalPort ?? "3210";
  }

  return resolved;
}
