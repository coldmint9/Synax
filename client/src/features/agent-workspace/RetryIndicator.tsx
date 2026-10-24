import { useEffect, useState } from "react";
import { RotateCw, WifiOff } from "lucide-react";
import type { LlmRetryState } from "../../adapters/transport/sessionLive";
import { useLocale } from "../../shared/hooks/useLocale";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";

export function RetryIndicator({ retry }: { retry: LlmRetryState }) {
  const { locale } = useLocale();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (retry.phase === "recovered" || retry.phase === "exhausted" || retry.nextRetryAt == null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retry.nextRetryAt, retry.phase]);
  if (retry.phase === "recovered") return null;
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
    retry.reason === "network" && retry.group > 1
      ? zh
        ? `第 ${retry.group} 组 · `
        : `Group ${retry.group} · `
      : "";
  const count = retry.maxRetries > 0
    ? `${retry.attempt}/${retry.maxRetries}`
    : String(retry.attempt);
  const attempt = zh ? `${group}第 ${count} 次重试` : `${group}Retry ${count}`;
  const retrying = retry.phase === "retrying" || retry.nextRetryAt == null;
  const announcement = retry.phase === "exhausted"
    ? zh ? "重试失败" : "Retries exhausted"
    : retrying
      ? zh ? "正在重试" : "Retrying"
      : zh ? "等待自动重试" : "Waiting to retry automatically";
  const status =
    retry.phase === "group_wait"
      ? zh
        ? `${seconds} 秒后开始第 ${retry.group} 组重试`
        : `Group ${retry.group} starts in ${seconds}s`
      : retry.phase === "exhausted"
        ? zh
          ? `已重试 ${retry.maxRetries} 次，仍然失败`
          : `Failed after ${retry.maxRetries} retries`
        : retrying
          ? zh
            ? `${attempt} · 正在重试…`
            : `${attempt} · Retrying…`
          : seconds === 0
            ? zh
              ? `${attempt} · 即将重试…`
              : `${attempt} · Retrying shortly…`
            : zh
              ? `${attempt} · ${seconds} 秒后重试`
              : `${attempt} · Retrying in ${seconds}s`;
  const Icon = retry.reason === "network" ? WifiOff : RotateCw;
  return (
    <StatusIndicator
      data-testid="retry-indicator"
      active={retry.phase !== "exhausted"}
      tone={retry.phase === "exhausted" ? "danger" : "warning"}
      icon={<Icon size={14} />}
      label={reason}
      announcement={`${reason} · ${attempt} · ${announcement}`}
      description={<span className="tabular-nums">{status}</span>}
    >
      <details className="text-muted-foreground">
        <summary className="cursor-pointer">
          {zh ? "错误详情" : "Error details"}
        </summary>
        <p data-error-toast="off" role="alert" className="mt-1 whitespace-pre-wrap break-words">{retry.error}</p>
      </details>
    </StatusIndicator>
  );
}
