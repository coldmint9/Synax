import { apiFetch, apiRequest, getApiOrigin } from "./origin";
import { MediaCache } from "./mediaCache";
export type {
  RuntimeContentPart,
  RuntimeAsset,
  InputCapabilities,
  InputModality,
} from "../../../../services/local-node/modules/agent-runtime/content-parts";
import type {
  RuntimeAsset,
  InputCapabilities,
} from "../../../../services/local-node/modules/agent-runtime/content-parts";
const BASE = "/api/agent-runtime/assets";
const metadataCache = new MediaCache<{ asset: RuntimeAsset }>(256, () => 1);
const blobCache = new MediaCache<Blob>(64 * 1024 * 1024, (blob) => blob.size);
const cacheKey = (id: string) => `${getApiOrigin()}${BASE}/${encodeURIComponent(id)}`;
export const runtimeMedia = {
  async upload(
    projectId: string,
    file: File,
    signal?: AbortSignal,
  ): Promise<RuntimeAsset> {
    const origin = getApiOrigin();
    const body = new FormData();
    body.set("projectId", projectId);
    body.set("file", file);
    const response = await apiFetch(BASE, {
      method: "POST",
      body,
      signal,
      priority: "high",
    });
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
    const key = `${origin}${BASE}/${encodeURIComponent(data.asset.id)}`;
    metadataCache.set(key, { asset: data.asset });
    blobCache.set(key, file);
    return data.asset;
  },
  metadata: (id: string) =>
    metadataCache.get(cacheKey(id), () =>
      apiRequest<{ asset: RuntimeAsset }>(`${BASE}/${encodeURIComponent(id)}`)),
  async blob(id: string, signal?: AbortSignal) {
    return blobCache.get(cacheKey(id), async () => {
      const response = await apiFetch(
      `${BASE}/${encodeURIComponent(id)}/content`,
    );
    if (!response.ok) throw new Error("附件不可用 / Attachment unavailable");
    return response.blob();
    }, signal);
  },
  remove: async (id: string) => {
    const key = cacheKey(id);
    const result = await apiRequest(`${BASE}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      silent: true,
    });
    metadataCache.delete(key);
    blobCache.delete(key);
    return result;
  },
  capabilities: (sessionId: string, model?: string) =>
    apiRequest<InputCapabilities>(
      `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/input-capabilities${model ? `?model=${encodeURIComponent(model)}` : ""}`,
      { silent: true },
    ),
};
