import { useEffect, useState } from "react";
import { apiRequest } from "../../../lib/api/origin";
import type { InputCapabilities } from "../../../lib/api/runtimeMedia";
import type { MediaDraft } from "./useMediaDraft";
export function useInputCapability(
  projectId: string,
  sessionId: string | undefined,
  backendId: string,
  model: string | undefined,
  media: MediaDraft | undefined,
  version?: string,
) {
  const [cap, setCap] = useState<InputCapabilities>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const key =
    media?.parts.map((p) => (p.type === "text" ? "" : p.assetId)).join(",") ??
    "";
  useEffect(() => {
    let active = true;
    setCap(undefined);
    setError("");
    if (!key) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const query = new URLSearchParams({ projectId, backendId });
    if (model) query.set("model", model);
    const endpoint = sessionId
      ? `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/input-capabilities?${query}`
      : `/api/agent-runtime/input-capabilities?${query}`;
    void apiRequest<InputCapabilities>(endpoint, { silent: true })
      .then((value) => {
        if (active) setCap(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, sessionId, backendId, model, key, version]);
  let reason = error;
  const deferred = backendId.endsWith("-acp") && !sessionId;
  if (cap && !cap.verified && !deferred)
    reason =
      "输入模态未确认，请在设置声明或选择兼容模型 / Input modalities unconfirmed";
  if (cap?.verified && media) {
    for (const item of media.items) {
      if (!item.asset) continue;
      const a = item.asset;
      const modality = a.mediaType.split("/")[0];
      const type = ["image", "audio", "video"].includes(modality)
        ? modality
        : "file";
      if (
        !cap.modalities.includes(type as never) ||
        (cap.mediaTypes &&
          !cap.mediaTypes.some((m) =>
            m.endsWith("/*")
              ? a.mediaType.startsWith(m.slice(0, -1))
              : m === a.mediaType,
          ))
      )
        reason = `当前模型不支持 ${a.filename} (${a.mediaType}) / Unsupported media`;
      if (a.size > cap.maxFileBytes)
        reason = `${a.filename} 超过模型文件上限 / Backend file limit exceeded`;
    }
    if (
      media.items.reduce((sum, i) => sum + (i.asset?.size ?? 0), 0) >
      cap.maxTotalBytes
    )
      reason = "附件合计超过模型请求上限 / Backend request limit exceeded";
  }
  return {
    blocked: Boolean(key && (loading || reason)),
    text: !key
      ? ""
      : loading
        ? "正在检查输入能力… / Checking modalities…"
        : reason ||
          (!cap?.verified
            ? "创建会话时协商附件能力 / Negotiated on session creation"
            : `输入 / Input: ${cap.modalities.join(" · ")}`),
    error: Boolean(reason),
  };
}
