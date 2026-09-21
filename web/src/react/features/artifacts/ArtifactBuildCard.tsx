import { useEffect, useState } from "react";
import { useLocale } from "../../../hooks/useLocale";
import { apiRequest } from "../../../lib/api/origin";
import type { ArtifactBuildJob } from "../../../../../api/services/agent-runtime/artifacts/contracts";
import "./artifacts.css";
export interface ArtifactJobReference {
  jobId: string;
  title: string;
}
export function ArtifactBuildCard({
  sessionId,
  reference,
}: {
  sessionId: string;
  reference: ArtifactJobReference;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [job, setJob] = useState<ArtifactBuildJob | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const url = `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/artifacts/jobs/${encodeURIComponent(reference.jobId)}`;
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const { job: next } = await apiRequest<{ job: ArtifactBuildJob }>(url, {
          silent: true,
        });
        if (!current) return;
        setJob(next);
        setError("");
        if (["queued", "building"].includes(next.status))
          timer = setTimeout(() => void load(), 800);
      } catch (e) {
        if (current)
          setError(e instanceof Error ? e.message : "Build status unavailable");
      }
    };
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [url, busy]);
  async function action(value: "cancel" | "retry") {
    setBusy(true);
    try {
      const result = await apiRequest<{ job: ArtifactBuildJob }>(
        `${url}/${value}`,
        { method: "POST", silent: true },
      );
      setJob(result.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Build action failed");
    } finally {
      setBusy(false);
    }
  }
  const labels = zh
    ? {
        queued: "排队中",
        building: "构建中",
        ready: "构建完成",
        failed: "构建失败",
        cancelled: "已取消",
      }
    : {
        queued: "Queued",
        building: "Building",
        ready: "Ready",
        failed: "Build failed",
        cancelled: "Cancelled",
      };
  return (
    <section
      className="artifact-card"
      aria-label={zh ? "交互产物构建" : "Artifact build"}
    >
      <header className="artifact-card-header">
        <strong>{reference.title}</strong>
        <span role="status">
          {job ? labels[job.status] : zh ? "读取构建状态…" : "Loading build…"}
        </span>
      </header>
      {error && (
        <p className="artifact-message artifact-error" role="alert">
          {error}
        </p>
      )}
      {job?.diagnostics.length ? (
        <pre className="artifact-message">{job.diagnostics.join("\n")}</pre>
      ) : null}
      <footer className="artifact-toolbar">
        <span>
          {job?.status === "ready"
            ? zh
              ? "新版本已发布到此会话"
              : "New revision published in this conversation"
            : zh
              ? "构建状态保存在会话中，刷新不会丢失"
              : "Build status survives reload"}
        </span>
        {job && ["queued", "building"].includes(job.status) && (
          <button disabled={busy} onClick={() => void action("cancel")}>
            {zh ? "取消构建" : "Cancel build"}
          </button>
        )}
        {job && ["failed", "cancelled"].includes(job.status) && (
          <button disabled={busy} onClick={() => void action("retry")}>
            {zh ? "重试构建" : "Retry build"}
          </button>
        )}
      </footer>
    </section>
  );
}
