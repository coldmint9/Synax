import type { ContextComposition } from "../../../lib/api/agentRuntime";
import { formatTokenCount } from "../../../lib/formatTokens";
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
}: {
  composition?: ContextComposition | null;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const heading = zh ? "上下文组成" : "Context composition";
  const total = composition
    ? CATEGORIES.reduce((sum, item) => sum + composition[item.key], 0)
    : 0;
  const items = CATEGORIES.map((item) => {
    const tokens = composition?.[item.key] ?? 0;
    const percent = total > 0 ? (tokens / total) * 100 : 0;
    return {
      ...item,
      tokens,
      percent,
      label: item.key === "messages" && !zh ? "Messages" : item.label,
      ratio: percent > 0 && percent < 0.1 ? "<0.1%" : percent.toFixed(1) + "%",
    };
  });
  return (
    <section className="space-y-2" aria-label={heading}>
      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
        <span>{heading}</span>
        <span
          className="text-muted-foreground/60"
          title={
            zh
              ? "按本轮请求的文本和工具 Schema 估算，不是累计用量；不含图片、音视频等非文本 Token。"
              : "Estimated from this request’s text and tool schemas, not cumulative usage. Non-text image/audio/video tokens are excluded."
          }
        >
          {zh ? "Token 估算" : "Estimated tokens"}
        </span>
      </div>
      {composition ? (
        <>
          <div
            role="img"
            aria-label={items
              .map((item) => item.label + " " + item.ratio)
              .join(" · ")}
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
                style={{ width: item.percent + "%" }}
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
                  {formatTokenCount(item.tokens)}
                </dd>
                <dd className="text-right tabular-nums text-muted-foreground/70">
                  {item.ratio}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="text-[9px] text-muted-foreground/60">
          {zh ? "暂无上下文组成记录" : "No context composition recorded yet"}
        </p>
      )}
    </section>
  );
}
