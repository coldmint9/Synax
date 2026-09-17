import type { ContextComposition, SessionStats } from "../../../lib/api/agentRuntime";
import { formatContextLimit, formatTokenCount } from "../../../lib/formatTokens";
import { useLocale } from "../../../hooks/useLocale";

const CATEGORIES = [
  {
    key: "tools",
    label: "Tools",
    color: "bg-blue-500",
    zh: "内置工具定义",
    en: "Built-in tool definitions",
  },
  {
    key: "mcp",
    label: "MCP",
    color: "bg-violet-500",
    zh: "MCP 工具定义",
    en: "MCP tool definitions",
  },
  {
    key: "skills",
    label: "Skills",
    color: "bg-amber-500",
    zh: "技能目录和已加载指令",
    en: "Skill catalog and loaded instructions",
  },
  {
    key: "messages",
    label: "消息",
    color: "bg-emerald-500",
    zh: "系统提示、对话和其他工具结果",
    en: "System prompt, conversation and other tool results",
  },
] as const;

export function ContextCompositionBar({
  composition,
  contextLimit,
  contextLimitKnown = true,
  context,
}: {
  composition?: ContextComposition | null;
  context?: SessionStats["context"];
  contextLimit?: number;
  contextLimitKnown?: boolean;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const heading = zh ? "上下文组成" : "Context composition";
  const estimatedTotal = composition
    ? CATEGORIES.reduce((sum, item) => sum + composition[item.key], 0)
    : 0;
  const reported = context?.source === "provider" ||
    (context?.latestRequestUsageAvailable === true && context.inputTokens !== null);
  const total = (reported || context?.source === "estimate") && context?.inputTokens != null
    ? context.inputTokens : estimatedTotal;
  const available = composition != null || (context?.inputTokens != null && (reported || context.source === "estimate"));
  const sourceLabel = reported
    ? (zh ? "服务商实测" : "Provider reported")
    : (zh ? "Token 估算" : "Estimated tokens");
  // The track spans the whole model context window. Only the tokens used by the
  // current context fill it; the rest stays empty. The four categories divide
  // that filled share, so their widths sum to the window usage, not to 100%.
  const knownWindow =
    contextLimitKnown !== false &&
    typeof contextLimit === "number" &&
    contextLimit > 0
      ? contextLimit
      : null;
  // Without a known window, fall back to filling the track with the measured
  // request so the four categories stay proportional to each other.
  const trackSize = knownWindow ?? total;
  const filled = knownWindow !== null ? Math.min(total, knownWindow) : total;
  // Guard against a measurement that overshoots the window: scale it down so the
  // filled share stays within the track instead of overflowing it.
  const overflowScale = total > 0 ? filled / total : 0;
  const toWidth = (tokens: number) =>
    total > 0 && trackSize > 0
      ? `${Number(((tokens / trackSize) * overflowScale * 100).toFixed(4))}%`
      : "0%";
  const items = CATEGORIES.map((item) => {
    const tokens = estimatedTotal > 0
      ? (composition?.[item.key] ?? 0) / estimatedTotal * total : 0;
    const percent = total > 0 ? (tokens / total) * 100 : 0;
    return {
      ...item,
      tokens,
      percent,
      width: toWidth(tokens),
      label: item.key === "messages" && !zh ? "Messages" : item.label,
      ratio: percent > 0 && percent < 0.1 ? "<0.1%" : percent.toFixed(1) + "%",
    };
  });
  const windowUsage = knownWindow !== null
    ? Number(((filled / knownWindow) * 100).toFixed(2))
    : null;
  return (
    <section className="space-y-2" aria-label={heading}>
      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
        <span>{heading}</span>
        <span
          className="text-muted-foreground/60"
          title={
            reported
              ? (zh ? "最近请求的完整输入 Token（含缓存），来自服务商 usage；不是会话累计量或下一轮精确用量。分类按同一请求的本地估算比例分配，不代表服务商分类计量。"
                : "Full input tokens including cache from the latest request's provider usage, not cumulative or exact next-turn usage. Categories are estimated proportions of the same request.")
              : (zh ? "按本轮文本和工具 Schema 本地估算；非原生 tokenizer、消息封装及图片等非文本输入可能造成误差。"
                : "Local text and tool-schema estimate. Tokenizer differences, message framing and non-text inputs can cause errors.")
          }
        >
          {available
            ? `${sourceLabel} · ${formatTokenCount(total)}${knownWindow !== null ? ` / ${formatContextLimit(knownWindow)}` : ""}`
            : sourceLabel}
        </span>
      </div>
      {context?.stale && <p className="text-[9px] text-muted-foreground/60">{zh ? "最近一次可用记录；当前请求暂无数据" : "Last available sample; current request has no data"}</p>}
      {composition && estimatedTotal > 0 ? (
        <>
          <div
            role="img"
            aria-label={
              items.map((item) => item.label + " " + item.ratio).join(" · ") +
              (windowUsage !== null
                ? ` · ${zh ? "窗口占用" : "window used"} ${windowUsage}%`
                : "")
            }
            className="flex h-2 w-full overflow-hidden rounded-full bg-secondary/60"
          >
            {items.map((item) => (
              <div
                key={item.key}
                data-context-category={item.key}
                className={
                  "h-full shrink-0 transition-[width] duration-500 ease-out motion-reduce:transition-none " +
                  item.color
                }
                style={{ width: item.width }}
                title={
                  item.label +
                  ": " +
                  formatTokenCount(item.tokens) +
                  " tokens · " +
                  item.ratio
                }
              />
            ))}
          </div>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
            {items.map((item) => (
              <div key={item.key} className="contents">
                <dt
                  className="flex min-w-0 items-center gap-1.5"
                  title={zh ? item.zh : item.en}
                >
                  <span
                    aria-hidden
                    className={
                      "h-1.5 w-1.5 shrink-0 rounded-full " + item.color
                    }
                  />
                  {item.label}
                </dt>
                <dd className="text-right tabular-nums">
                  {reported ? "≈" : ""}{formatTokenCount(Math.round(item.tokens))}
                </dd>
                <dd className="text-right tabular-nums text-muted-foreground/70">
                  {item.ratio}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : available ? (
        <div role="img" aria-label={`${zh ? "窗口占用" : "Window used"} ${windowUsage ?? "—"}%`} className="h-2 overflow-hidden rounded-full bg-secondary/60">
          <div className="h-full bg-emerald-500" style={{ width: toWidth(total) }} />
        </div>
      ) : (
        <p className="text-[9px] text-muted-foreground/60">
          {zh ? "暂无上下文组成记录" : "No context composition recorded yet"}
        </p>
      )}
    </section>
  );
}
