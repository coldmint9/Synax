import type { ApiFormat } from "../../infrastructure/runtime/config/config-types.js";

/**
 * Contract between the cc-switch source adapter (raw SQLite rows) and the
 * Synax provider config. Raw records may carry plaintext API keys: they are
 * only ever handed to the import orchestration, never serialized to HTTP.
 */

/** CLI apps this import supports in the first release. */
export const CC_SWITCH_SUPPORTED_APPS = ["claude", "codex"] as const;
export type CcSwitchAppType = (typeof CC_SWITCH_SUPPORTED_APPS)[number];

export function isSupportedCcSwitchApp(appType: string): appType is CcSwitchAppType {
  return (CC_SWITCH_SUPPORTED_APPS as readonly string[]).includes(appType);
}

/** One row of cc-switch's `providers` table, JSON columns already parsed. */
export interface CcSwitchProviderRecord {
  appType: string;
  id: string;
  name: string;
  category: string | null;
  isCurrent: boolean;
  settingsConfig: unknown;
  meta: Record<string, unknown>;
}

export interface CcSwitchModelCandidate {
  id: string;
  contextLimit?: number;
  inputModalities?: Array<"text" | "image" | "audio" | "video" | "file">;
  outputModalities?: Array<"text" | "image" | "audio" | "video" | "file">;
}

/** A provider that can be imported into Synax, with its key resolved. */
export interface CcSwitchProviderCandidate {
  /** Stable source identity: `<appType>:<providerId>`. */
  key: string;
  appType: CcSwitchAppType;
  sourceId: string;
  label: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  /** Plaintext key; stays in the server process. */
  apiKey: string;
  apiKeyMasked: string;
  models: CcSwitchModelCandidate[];
  defaultModel: string;
  warnings: string[];
}

export interface CcSwitchSkippedProvider {
  key: string;
  appType: string;
  label: string;
  reason: string;
}

export type CcSwitchConflictKind = "none" | "duplicate-id" | "same-endpoint";

/** Preview item safe to serialize: never contains the API key. */
export interface CcSwitchImportItem {
  key: string;
  appType: string;
  label: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  apiKeyMasked: string;
  declaredModels: string[];
  defaultModel: string;
  conflict: CcSwitchConflictKind;
  /** Existing Synax provider that collides with this candidate. */
  conflictProviderId?: string;
  selectable: boolean;
  reason?: string;
  warnings: string[];
}

export interface CcSwitchPreview {
  available: boolean;
  sourcePath: string;
  items: CcSwitchImportItem[];
  unsupported: CcSwitchSkippedProvider[];
  warnings: string[];
}

export type CcSwitchConflictPolicy = "skip" | "replace" | "copy";

export interface CcSwitchImportAction {
  providerId: string;
  label: string;
  action: "created" | "updated" | "skipped";
  reason?: string;
}
