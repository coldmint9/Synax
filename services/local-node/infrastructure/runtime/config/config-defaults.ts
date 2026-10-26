import type {
  GlobalConfig,
  MacWindowAppearance,
  ProviderDef,
  WebSearchConfig,
} from "./config-types.js";

export const DEFAULT_MAC_WINDOW_APPEARANCE: MacWindowAppearance = {
  enabled: false,
  vibrancy: "under-window",
  opacity: 0.82,
  bottomSeparator: true,
  scanlines: false,
  scanlineOpacity: 0.025,
};

function createBuiltinApiProvider(
  id: "openai" | "anthropic",
  label: string,
  description: string,
  defaultModel: string,
): ProviderDef {
  return {
    id,
    label,
    description,
    status: "live",
    kind: "api",
    caps: { canFollowUp: true, canCancel: true },
    models: [{ id: defaultModel, label: defaultModel, isDefault: true }],
  };
}

export const BUILTIN_PROVIDERS: ProviderDef[] = [
  createBuiltinApiProvider(
    "openai",
    "OpenAI",
    "OpenAI-compatible API",
    "gpt-4o-mini",
  ),
  createBuiltinApiProvider(
    "anthropic",
    "Anthropic",
    "Anthropic Messages API",
    "claude-3-5-sonnet-latest",
  ),
];

export function createDefaultWebSearchConfig(): WebSearchConfig {
  return {
    routing: "auto",
    remote: {
      externalWebAccess: true,
      searchContextSize: "medium",
    },
    local: {
      engine: "duckduckgo",
      auth: { type: "none" },
    },
  };
}

export function createDefaultGlobalConfig(updatedBy = "system"): GlobalConfig {
  const now = new Date().toISOString();
  return {
    version: 1,
    providers: BUILTIN_PROVIDERS,
    defaultProviderId: "openai",
    defaultApiProviderId: "openai",
    mcpServers: [],
    computerUse: { enabled: false, strategy: "auto", perception: "disabled" },
    macWindowAppearance: { ...DEFAULT_MAC_WINDOW_APPEARANCE },
    webSearch: createDefaultWebSearchConfig(),
    sessionArchiveRetentionDays: 7,
    providerConnections: {
      openai: {
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        extra: {
          kind: "api",
          apiFormat: "openai",
          model: "gpt-4o-mini",
        },
      },
      anthropic: {
        providerId: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        extra: {
          kind: "api",
          apiFormat: "anthropic",
          model: "claude-3-5-sonnet-latest",
        },
      },
    },
    limits: {
      maxAgentsPerProject: 10,
      agentTimeoutMs: 300_000,
    },
    features: {
      allowProjectConnectionOverride: true,
    },
    updatedAt: now,
    updatedBy,
  };
}

export function createDefaultUserGlobalConfig(
  updatedBy = "system",
): GlobalConfig {
  const now = new Date().toISOString();
  return {
    version: 1,
    providers: [],
    defaultProviderId: "openai",
    defaultApiProviderId: "openai",
    mcpServers: [],
    computerUse: { enabled: false, strategy: "auto", perception: "disabled" },
    macWindowAppearance: { ...DEFAULT_MAC_WINDOW_APPEARANCE },
    webSearch: createDefaultWebSearchConfig(),
    sessionArchiveRetentionDays: 7,
    providerConnections: {},
    limits: {
      maxAgentsPerProject: 10,
      agentTimeoutMs: 300_000,
    },
    features: {
      allowProjectConnectionOverride: true,
    },
    updatedAt: now,
    updatedBy,
  };
}
