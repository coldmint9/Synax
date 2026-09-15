import { apiFetch, apiRequest } from "./origin";
export type {
  RuntimeContentPart,
  RuntimeAsset,
  InputCapabilities,
  InputModality,
} from "../../../../api/services/agent-runtime/content-parts";
import type {
  RuntimeAsset,
  InputCapabilities,
} from "../../../../api/services/agent-runtime/content-parts";
const BASE = "/api/agent-runtime/assets";
export const runtimeMedia = {
  async upload(
    projectId: string,
    file: File,
    signal?: AbortSignal,
  ): Promise<RuntimeAsset> {
    const body = new FormData();
    body.set("projectId", projectId);
    body.set("file", file);
    const response = await apiFetch(BASE, { method: "POST", body, signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = typeof data?.error === "string" ? data.error : undefined;
      throw new Error(
        detail ??
          (response.status === 404
            ? "附件上传接口未就绪（HTTP 404），请重启 Synax API 后重试。"
            : `附件上传失败（HTTP ${response.status}），请检查 Synax API 后重试。`),
      );
    }
    if (
      typeof data?.asset?.id !== "string" ||
      typeof data?.asset?.mediaType !== "string"
    ) {
      throw new Error("附件上传接口返回了无效响应，请检查 Synax API 后重试。");
    }
    return data.asset;
  },
  metadata: (id: string) =>
    apiRequest<{ asset: RuntimeAsset }>(`${BASE}/${encodeURIComponent(id)}`),
  async blob(id: string, signal?: AbortSignal) {
    const response = await apiFetch(
      `${BASE}/${encodeURIComponent(id)}/content`,
      { signal },
    );
    if (!response.ok) throw new Error("附件不可用 / Attachment unavailable");
    return response.blob();
  },
  remove: (id: string) =>
    apiRequest(`${BASE}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      silent: true,
    }),
  capabilities: (sessionId: string, model?: string) =>
    apiRequest<InputCapabilities>(
      `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/input-capabilities${model ? `?model=${encodeURIComponent(model)}` : ""}`,
      { silent: true },
    ),
};
