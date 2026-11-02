import {
  configureUpdateNetwork,
  DEFAULT_UPDATE_NETWORK,
  validateUpdateNetworkSettings,
  type UpdateNetworkSettings,
} from "../lib/update-network.js";
import { frameworkFeedUrl } from "./update-source.js";

/** Everything the user may change about online updates. The feed stays
 * subject to the same enterprise-source rules as the packaged configuration. */
export interface UpdateSettings extends UpdateNetworkSettings {
  enabled: boolean;
  sourceUrl: string;
}

export const DEFAULT_UPDATE_SETTINGS: Readonly<UpdateSettings> = Object.freeze({
  ...DEFAULT_UPDATE_NETWORK,
  enabled: false,
  sourceUrl: "",
});

export function validateUpdateSettings(value: unknown): UpdateSettings {
  const input = value as Partial<UpdateSettings> | null | undefined;
  const network = validateUpdateNetworkSettings({
    mode: input?.mode,
    customProxyUrl: input?.customProxyUrl,
  });
  // Settings files written before online updates became configurable only
  // carry proxy preferences and must keep working as "updates off".
  const enabled = input?.enabled ?? false;
  if (typeof enabled !== "boolean")
    throw new Error("Invalid update settings: enabled must be a boolean");
  const source = input?.sourceUrl ?? "";
  if (typeof source !== "string" || source.length > 2048)
    throw new Error("Invalid update settings: update source must be a string");
  const sourceUrl = source.trim()
    ? frameworkFeedUrl({ SYNAX_FRAMEWORK_UPDATE_URL: source })
    : "";
  return { ...network, enabled, sourceUrl };
}

let settings: Readonly<UpdateSettings> = DEFAULT_UPDATE_SETTINGS;

/** Applies one validated settings object to every runtime consumer. */
export function configureUpdateSettings(value: UpdateSettings): UpdateSettings {
  const next = Object.freeze(validateUpdateSettings(value));
  configureUpdateNetwork(next);
  settings = next;
  return { ...next };
}

export function currentUpdateSettings(): UpdateSettings {
  return { ...settings };
}

/** The user-configured feed, or "" when the installer build supplies one. */
export function configuredUpdateSource(): string {
  return settings.sourceUrl;
}
