import { useShellStore } from "../../react/state/shellStore";
import { useNotificationStore } from "../../react/state/notificationStore";

export interface FileOpener { id: string; name: string; icon: string | null }

import type {
  AcpDiscoveryResponse,
  AiApiModelsDiscoverRequest,
  AiApiModelsDiscoverResponse,
  AiApiValidateRequest,
  AiApiValidateResponse,
  EffectiveConfigResponse,
  GlobalConfigResponse,
  McpServerConfig,
  ProjectConfigResponse,
  ProviderListResponse,
  UpdateGlobalConfigRequest,
  UpdateProjectConfigRequest,
} from "../contracts/config";
import { apiFetch } from "./origin";

const BASE = "/api/config";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!resp.ok) {
    const body = await resp.text();
    let message: string | undefined;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      message = parsed.error;
    } catch {
      message = undefined;
    }
    throw new Error(message || `Config API error ${resp.status}: ${body}`);
  }
  return resp.json();
}

async function openWithPreference(body: Record<string, unknown>): Promise<void> {
  const { editor, locale } = useShellStore.getState().preferences;
  const result = await request<{ ok: true; fallback?: boolean }>(`${BASE}/open-file`, {
    method: "POST",
    body: JSON.stringify({ ...body, opener: editor }),
  });
  if (result.fallback) useNotificationStore.getState().push({
    type: "warning",
    message: locale === "zh" ? "所选应用已不可用，已使用系统默认应用打开。" : "The selected app is unavailable. Opened with the system default.",
  });
}

export const configApi = {
  listFileOpeners: () => request<{ apps: FileOpener[] }>(`${BASE}/file-openers`),
  getTerminalShell: () =>
    request<{ defaultPath: string }>(`${BASE}/terminal-shell`),
  async openGlobalFile(): Promise<void> {
    await openWithPreference({ target: "global" });
  },

  async getGlobal(): Promise<GlobalConfigResponse> {
    return request<GlobalConfigResponse>(`${BASE}/global`);
  },

  async updateGlobal(
    patch: UpdateGlobalConfigRequest,
  ): Promise<GlobalConfigResponse> {
    return request<GlobalConfigResponse>(`${BASE}/global`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },

  async startWebSearchOAuth(): Promise<{ authorizationUrl: string }> {
    return request<{ authorizationUrl: string }>(
      `${BASE}/web-search/oauth/start`,
      { method: "POST" },
    );
  },

  async listProviders(): Promise<ProviderListResponse> {
    return request<ProviderListResponse>(`${BASE}/global/providers`);
  },

  async discoverAcp(): Promise<AcpDiscoveryResponse> {
    return request<AcpDiscoveryResponse>(`${BASE}/acp/discovery`);
  },

  async validateAiApi(
    payload: AiApiValidateRequest,
  ): Promise<AiApiValidateResponse> {
    const resp = await apiFetch(`${BASE}/ai-api/validate`, {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify(payload),
    });
    const body = await resp
      .json()
      .catch(() => ({ ok: false, error: `validate failed (${resp.status})` }));
    return body as AiApiValidateResponse;
  },

  async discoverAiModels(
    payload: AiApiModelsDiscoverRequest,
  ): Promise<AiApiModelsDiscoverResponse> {
    const resp = await apiFetch(`${BASE}/ai-api/models/discover`, {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify(payload),
    });
    const body = await resp.json().catch(() => ({
      ok: false,
      models: [],
      source: "api/models",
      error: `discover models failed (${resp.status})`,
    }));
    return body as AiApiModelsDiscoverResponse;
  },

  async getProject(projectId: string): Promise<ProjectConfigResponse> {
    return request<ProjectConfigResponse>(
      `${BASE}/projects/${projectId}/config`,
    );
  },

  async updateProject(
    projectId: string,
    patch: UpdateProjectConfigRequest,
  ): Promise<ProjectConfigResponse> {
    return request<ProjectConfigResponse>(
      `${BASE}/projects/${projectId}/config`,
      {
        method: "PUT",
        body: JSON.stringify(patch),
      },
    );
  },

  async deleteProject(projectId: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>(
      `${BASE}/projects/${projectId}/config`,
      {
        method: "DELETE",
      },
    );
  },

  async getEffective(projectId: string): Promise<EffectiveConfigResponse> {
    return request<EffectiveConfigResponse>(
      `${BASE}/projects/${projectId}/config/effective`,
    );
  },

  async testMcpServer(config: McpServerConfig): Promise<{
    ok: boolean;
    tools: Array<{ name: string; description?: string }>;
    error?: string;
  }> {
    const resp = await apiFetch("/api/mcp/test", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify(config),
    });
    const body = await resp.json().catch(() => ({
      ok: false,
      tools: [],
      error: `test failed (${resp.status})`,
    }));
    return body as {
      ok: boolean;
      tools: Array<{ name: string; description?: string }>;
      error?: string;
    };
  },

  async openFile(
    filePath: string,
    line?: number,
    location?:
      | { kind: "host"; path: string }
      | { kind: "wsl"; distribution: string; path: string },
  ): Promise<void> {
    await openWithPreference({
      filePath,
      ...(line != null ? { line } : {}),
      ...(location ? { location } : {}),
    });
  },
};
