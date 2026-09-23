export type ProviderStatus = "live" | "experimental" | "inactive";
export type ProviderKind = "acp" | "api";
export type ApiFormat = "openai" | "openai-responses" | "anthropic";

export interface ProviderCaps {
  canFollowUp: boolean;
  canCancel: boolean;
}

export interface ProviderDef {
  id: string;
  label: string;
  description?: string;
  status: ProviderStatus;
  kind: ProviderKind;
  caps: ProviderCaps;
  models: ProviderModelDef[];
  connectionSchema?: Record<string, unknown>;
}

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ProviderModelDef {
  inputModalities?: Array<"text" | "image" | "audio" | "video" | "file">;
  outputModalities?: Array<"text" | "image" | "audio" | "video" | "file">;
  id: string;
  label: string;
  isDefault?: boolean;
  maxTokens?: number;
  /** Input context window in tokens (1_000_000 when the 1M input-context checkbox is set). */
  contextLimit?: number;
}

export interface ProviderConnection {
  providerId: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyMasked?: string;
  extra?: Record<string, unknown>;
}

export interface McpServerConfig {
  transport?: "stdio" | "http";
  url?: string;
  headers?: Record<string, string>;
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}

export type WebSearchRouting = "auto" | "remote" | "local" | "disabled";
export type WebSearchEngine = "duckduckgo" | "brave" | "tavily" | "custom";
export type WebSearchAuthType = "none" | "api-key" | "bearer" | "oauth2";

export interface WebSearchAuthConfig {
  type: WebSearchAuthType;
  headerName?: string;
  tokenPrefix?: string;
  apiKey?: string;
  apiKeyMasked?: string;
  bearerToken?: string;
  bearerTokenMasked?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  clientSecretMasked?: string;
  scopes?: string[];
  accessToken?: string;
  accessTokenMasked?: string;
  refreshToken?: string;
  refreshTokenMasked?: string;
  expiresAt?: number;
}

export interface WebSearchConfig {
  routing: WebSearchRouting;
  remote: {
    externalWebAccess: boolean;
    searchContextSize: "low" | "medium" | "high";
  };
  local: {
    engine: WebSearchEngine;
    endpoint?: string;
    method?: "GET" | "POST";
    queryParam?: string;
    resultPath?: string;
    titleField?: string;
    urlField?: string;
    snippetField?: string;
    auth: WebSearchAuthConfig;
  };
}

export interface McpDiscoverySource {
  client: string;
  path: string;
  scope: "project" | "user";
}

export interface DiscoveredMcpServer {
  fingerprint: string;
  server: McpServerConfig;
  sources: McpDiscoverySource[];
}

export interface McpDiscoveryResponse {
  servers: DiscoveredMcpServer[];
  scannedFiles: number;
  warnings: Array<{ client: string; path: string; message: string }>;
}

export interface GlobalConfig {
  terminalShellPath?: string;
  wikiModel?: string;
  version: number;
  providers: ProviderDef[];
  defaultProviderId: string;
  defaultApiProviderId: string;
  enabledAcpProviderIds: string[];
  providerConnections: Record<string, ProviderConnection>;
  mcpServers: McpServerConfig[];
  webSearch: WebSearchConfig;
  limits: {
    maxAgentsPerProject: number;
    agentTimeoutMs: number;
  };
  features: {
    allowProjectConnectionOverride: boolean;
  };
  updatedAt: string;
  updatedBy: string;
}

export interface ProjectConfig {
  projectId: string;
  version: number;
  providerId?: string | null;
  modelId?: string | null;
  providerConnection?: ProviderConnection | null;
  limits?: {
    maxAgentsPerProject?: number;
    agentTimeoutMs?: number;
  };
  custom?: Record<string, string>;
  updatedAt: string;
  updatedBy: string;
}

export interface EffectiveConfig {
  providerId: string;
  modelId: string;
  provider: ProviderDef;
  model: ProviderModelDef;
  connection: ProviderConnection;
  limits: GlobalConfig["limits"];
}

export interface AnalyzerLlmConfig {
  providerId: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  apiKey?: string;
  apiKeyMasked?: string;
  model: string;
}

export interface UpdateGlobalConfigRequest {
  terminalShellPath?: string;
  wikiModel?: string;
  providers?: ProviderDef[];
  defaultProviderId?: string;
  defaultApiProviderId?: string;
  enabledAcpProviderIds?: string[];
  providerConnections?: Record<string, ProviderConnection>;
  mcpServers?: McpServerConfig[];
  webSearch?: WebSearchConfig;
  limits?: GlobalConfig["limits"];
  features?: GlobalConfig["features"];
}

export interface UpdateProjectConfigRequest {
  providerId?: string | null;
  modelId?: string | null;
  providerConnection?: ProviderConnection | null;
  limits?: ProjectConfig["limits"];
  custom?: Record<string, string>;
}

export interface GlobalConfigResponse {
  config: GlobalConfig;
}

export interface ProjectConfigResponse {
  config: ProjectConfig | null;
}

export interface EffectiveConfigResponse {
  config: EffectiveConfig;
}

export interface AiApiModelsDiscoverRequest {
  providerId?: string;
  format: ApiFormat;
  baseUrl: string;
  apiKey?: string;
}

export interface AiApiModelsDiscoverResponse {
  ok: boolean;
  models: string[];
  source: string;
  error?: string;
  resolvedBaseUrl?: string;
}
