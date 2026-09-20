import { useEffect, useState } from "react";
import { RotateCw, WifiOff } from "lucide-react";
import type { LlmRetryState } from "../../../lib/api/sessionLive";
import { useLocale } from "../../../hooks/useLocale";

export function RetryIndicator({ retry }: { retry: LlmRetryState }) {
  const { locale } = useLocale();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (retry.nextRetryAt == null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retry.nextRetryAt]);
  const zh = locale === "zh";
  const seconds = Math.max(
    0,
    Math.ceil(((retry.nextRetryAt ?? now) - now) / 1000),
  );
  const reason =
    retry.reason === "network"
      ? zh
        ? "网络连接异常"
        : "Network connection issue"
      : retry.reason === "rate_limit"
        ? zh
          ? "上游请求限流"
          : "Upstream rate limited"
        : zh
          ? "上游服务繁忙"
          : "Upstream service unavailable";
  const group =
    retry.reason === "network"
      ? zh
        ? `第 ${retry.group} 组 · `
        : `Group ${retry.group} · `
      : "";
  const attempt = zh
    ? `${group}第 ${retry.attempt}/${retry.maxRetries} 次重试`
    : `${group}Retry ${retry.attempt}/${retry.maxRetries}`;
  const status =
    retry.phase === "group_wait"
      ? zh
        ? `${seconds} 秒后开始第 ${retry.group} 组重试`
        : `Group ${retry.group} starts in ${seconds}s`
      : retry.phase === "exhausted"
        ? zh
          ? `已重试 ${retry.maxRetries} 次，仍然失败`
          : `Failed after ${retry.maxRetries} retries`
        : retry.phase === "retrying"
          ? zh
            ? `${attempt} · 正在重试…`
            : `${attempt} · Retrying…`
          : zh
            ? `${attempt} · ${seconds} 秒后重试`
            : `${attempt} · Retrying in ${seconds}s`;
  const Icon = retry.reason === "network" ? WifiOff : RotateCw;
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-warning">
      <Icon size={14} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <div role="status" aria-live="polite">
          {reason}
        </div>
        <div className="mt-1 tabular-nums">{status}</div>
        <details className="mt-1 text-muted-foreground">
          <summary className="cursor-pointer">
            {zh ? "错误详情" : "Error details"}
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{retry.error}</p>
        </details>
      </div>
    </div>
  );
}
