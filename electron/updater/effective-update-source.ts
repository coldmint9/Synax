import { readFileSync } from "node:fs";
import path from "node:path";
import { frameworkFeedUrl, resolveUpdateSource } from "./update-source.js";
import { requireOnlineUpdates } from "./update-policy.js";
import { configuredUpdateSource } from "./update-settings.js";

export interface UpdateSourceOptions {
  env?: Record<string, string | undefined>;
  resourcesPath?: string;
  readConfig?: (file: string) => string;
  /** Overrides the saved user preference, for callers that already know it. */
  sourceUrl?: string;
}

/** Forge writes JSON (valid YAML) in resources/app-update.yml. Do not search
 * profile/cwd caches or silently consume an upstream electron-updater config. */
export function effectiveUpdateSource(options: UpdateSourceOptions = {}): string {
  requireOnlineUpdates();
  const env = options.env ?? process.env;
  // A user-configured feed wins and never falls back: the settings store
  // validates it with the same enterprise-source rules as the build.
  const configured = options.sourceUrl ?? configuredUpdateSource();
  if (configured.trim())
    return frameworkFeedUrl({ SYNAX_FRAMEWORK_UPDATE_URL: configured });
  if (env.SYNAX_FRAMEWORK_UPDATE_URL !== undefined) return resolveUpdateSource(env);
  const resources = options.resourcesPath ??
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resources) return resolveUpdateSource(env);
  const read = options.readConfig ?? ((file: string) => readFileSync(file, "utf8"));
  let config: unknown;
  try { config = JSON.parse(read(path.join(resources, "app-update.yml"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolveUpdateSource(env);
    throw new Error("Synax 企业更新源打包配置无法读取或解析。", { cause: error });
  }
  return resolveUpdateSource(env, config);
}
