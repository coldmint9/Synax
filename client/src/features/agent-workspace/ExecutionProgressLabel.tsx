import { useEffect, useState } from "react";
import type { ToolExecutionProgress } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";

export function executionProgressText(progress: ToolExecutionProgress, locale: string): string {
  const zh = locale === "zh";
  if (progress.phase === "queued_resources") {
    const resources: Record<string, [string, string]> = {
      search: ["搜索资源", "search capacity"], provider: ["模型额度", "model capacity"],
      command: ["命令资源", "command capacity"], io: ["文件资源", "file capacity"], worker: ["会话资源", "a session worker"],
    };
    const resource = resources[progress.resource ?? ""];
    return zh ? `等待${resource?.[0] ?? "执行资源"}` : `Waiting for ${resource?.[1] ?? "execution capacity"}`;
  }
  if (progress.phase === "cancelling") return zh ? "正在停止工具" : "Stopping tool";
  if (progress.phase === "generating") return zh ? "模型生成中" : "Generating response";
  if (progress.files !== undefined) return zh ? `正在搜索 · 已扫描 ${progress.files} 个文件` : `Searching · ${progress.files} files scanned`;
  return zh ? "工具执行中" : "Executing tools";
}

export function ExecutionProgressLabel({ progress }: { progress: ToolExecutionProgress }) {
  const { locale } = useLocale();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (progress.phase === "waiting_model") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [progress.phase]);
  if (progress.phase === "waiting_model") return null;
  const since = progress.phase === "queued_resources" ? progress.queuedAt : progress.startedAt;
  const elapsed = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : null;
  const overdue = progress.deadline && now > Date.parse(progress.deadline);
  return <StatusIndicator
    inline
    active
    announce={false}
    data-execution-phase={progress.phase}
    label={overdue && progress.phase !== "cancelling"
      ? locale === "zh" ? "执行超时，正在确认工具状态" : "Deadline exceeded; checking tool state"
      : executionProgressText(progress, locale)}
    meta={elapsed !== null && Number.isFinite(elapsed) ? <span aria-hidden="true">· {elapsed}s</span> : undefined}
  />;
}
