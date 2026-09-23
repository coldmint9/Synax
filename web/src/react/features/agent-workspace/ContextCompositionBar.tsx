import type { SessionStats } from "../../../lib/api/agentRuntime";
import {
  formatContextLimit,
  formatTokenCount,
} from "../../../lib/formatTokens";
import { useLocale } from "../../../hooks/useLocale";

export function contextUsage(context?: SessionStats["context"]) {
  // Accept older provider snapshots without a source only when usage was reported.
  // Explicit legacy estimates must never become provider measurements.
  const reported =
    context?.source === "provider" ||
    (context?.source == null && context?.latestRequestUsageAvailable === true);
  const tokens = context?.inputTokens;
  const available =
    reported &&
    typeof tokens === "number" &&
    Number.isSafeInteger(tokens) &&
    tokens >= 0;
  return { reported: available, total: available ? tokens : 0, available };
}

export function ContextCompositionBar({
  contextLimit,
  contextLimitKnown = true,
  context,
}: {
  context?: SessionStats["context"];
  contextLimit?: number;
  contextLimitKnown?: boolean;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const heading = zh ? "上下文用量" : "Context usage";
  const { total, available } = contextUsage(context);
  const knownWindow =
    contextLimitKnown !== false &&
    typeof contextLimit === "number" &&
    Number.isFinite(contextLimit) &&
    contextLimit > 0
      ? contextLimit
      : null;
  const windowUsage =
    available && knownWindow !== null
      ? Number(((total / knownWindow) * 100).toFixed(2))
      : null;
  const stale = available && context?.stale === true;
  return (
    <section className="space-y-2" aria-label={heading}>
      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
        <span>{heading}</span>
        {available && (
          <span
            className="text-muted-foreground/60"
            title={
              zh
                ? "最近一次供应商返回的完整输入 Token（含缓存）；不是会话累计量或下一轮精确用量。"
                : "Last provider-reported full input tokens including cache; not cumulative or exact next-turn usage."
            }
          >
            {`${zh ? "服务商实测" : "Provider reported"} · ${formatTokenCount(total)}${knownWindow !== null ? ` / ${formatContextLimit(knownWindow)}` : ""}`}
          </span>
        )}
      </div>
      {stale && (
        <p className="text-[9px] text-muted-foreground/60">
          {zh
            ? "上次请求的供应商数据；当前请求暂无数据"
            : "Last request's provider data; current request has no data"}
        </p>
      )}
      {windowUsage !== null ? (
        <div
          role="img"
          aria-label={`${stale ? (zh ? "上次请求 · " : "Last request · ") : ""}${zh ? "窗口占用" : "Window used"} ${windowUsage}%`}
          className="h-2 overflow-hidden rounded-full bg-secondary/60"
        >
          <div
            className="h-full bg-emerald-500"
            style={{ width: `${Math.min(windowUsage, 100)}%` }}
          />
        </div>
      ) : !available ? (
        <p className="text-[9px] text-muted-foreground/60">
          {zh ? "暂无供应商数据" : "No provider usage available"}
        </p>
      ) : null}
    </section>
  );
}
