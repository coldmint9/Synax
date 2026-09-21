import { useEffect, useState } from "react";
import { apiRequest } from "../../../lib/api/origin";
import { useLocale } from "../../../hooks/useLocale";
import "./artifacts.css";
export interface ArtifactPublicationReference {
  requestId: string;
  title: string;
  sourcePath: string;
}
export function ArtifactPublicationCard({
  sessionId,
  reference,
}: {
  sessionId: string;
  reference: ArtifactPublicationReference;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [status, setStatus] = useState("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/artifacts/requests/${encodeURIComponent(reference.requestId)}`;
  useEffect(() => {
    let active = true;
    apiRequest<{ status: string }>(url, { silent: true })
      .then((result) => {
        if (active) setStatus(result.status);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [url]);
  useEffect(() => {
    if (status !== "publishing") return;
    let active = true;
    const timer = setInterval(() => {
      void apiRequest<{ status: string }>(url, { silent: true })
        .then((r) => {
          if (active) setStatus(r.status);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [status, url]);
  async function decide(action: "approve" | "reject") {
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<{ status: string }>(url, {
        method: "POST",
        silent: true,
        headers: {
          "Content-Type": "application/json",
          "X-Synax-Artifact-Action": "confirm-publication",
        },
        body: JSON.stringify({ action }),
      });
      setStatus(result.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publication failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="artifact-card"
      aria-label={zh ? "发布审批" : "Publication approval"}
    >
      <header className="artifact-card-header">
        <strong>{reference.title}</strong>
        <span>{zh ? "发布审批" : "Publication approval"}</span>
      </header>
      <div className="artifact-message">
        <code>{reference.sourcePath}</code>
        <p>
          {status === "publishing"
            ? zh
              ? "已批准，正在构建…"
              : "Approved; building…"
            : status === "ready"
              ? zh
                ? "已批准并发布，预览在下方会话中。"
                : "Approved and published below."
              : status === "rejected"
                ? zh
                  ? "已拒绝发布。"
                  : "Publication rejected."
                : zh
                  ? "Agent 请求读取并快照此工作区文件，构建交互产物。批准发布不会授予原型文件、网络或工具权限。"
                  : "The agent requests reading and snapshotting this workspace file into an interactive artifact. Approval does not grant the preview file, network or tool access."}
        </p>
        {error && <p role="alert">{error}</p>}
      </div>
      {status === "pending" && (
        <footer className="artifact-toolbar">
          <button disabled={busy} onClick={() => void decide("reject")}>
            {zh ? "拒绝" : "Reject"}
          </button>
          <button disabled={busy} onClick={() => void decide("approve")}>
            {busy
              ? zh
                ? "构建中…"
                : "Building…"
              : zh
                ? "批准并发布"
                : "Approve and publish"}
          </button>
        </footer>
      )}
    </section>
  );
}
