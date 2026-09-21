import { Plug, Sparkles, Wrench } from "lucide-react";
import type {
  SessionInvocationKind,
  SessionInvocationUsageResponse,
} from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";

const GROUPS: Array<{
  kind: SessionInvocationKind;
  icon: typeof Wrench;
  zh: string;
  en: string;
}> = [
  { kind: "tool", icon: Wrench, zh: "工具", en: "Tools" },
  { kind: "skill", icon: Sparkles, zh: "技能", en: "Skills" },
  { kind: "mcp", icon: Plug, zh: "MCP", en: "MCP" },
];

export function SessionInvocationUsagePanel({
  usage,
}: {
  usage: SessionInvocationUsageResponse;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";

  return (
    <section
      className="border-b border-border/40 px-2 py-2"
      aria-label={zh ? "调用统计" : "Invocation usage"}
    >
      <div className="flex items-center justify-between text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        <span>{zh ? "调用统计" : "Invocation usage"}</span>
        <span className="tabular-nums normal-case tracking-normal text-muted-foreground/70">
          {usage.totalCalls} {zh ? "次" : usage.totalCalls === 1 ? "call" : "calls"}
        </span>
      </div>

      {usage.items.length === 0 ? (
        <p className="pt-2 text-[10px] text-muted-foreground/50">
          {zh
            ? "本会话尚未调用工具、技能或 MCP。"
            : "This session has not invoked any tools, skills, or MCP servers."}
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {GROUPS.map(({ kind, icon: Icon, zh: zhLabel, en }) => {
            const items = usage.items.filter((item) => item.kind === kind);
            if (items.length === 0) return null;
            const total = items.reduce((sum, item) => sum + item.callCount, 0);
            return (
              <div key={kind} data-invocation-kind={kind}>
                <div className="flex items-center gap-1 text-[8px] uppercase tracking-wider text-muted-foreground/55">
                  <Icon size={9} aria-hidden />
                  <span>{zh ? zhLabel : en}</span>
                  <span className="ml-auto tabular-nums normal-case tracking-normal">
                    {total} {zh ? "次" : total === 1 ? "call" : "calls"}
                  </span>
                </div>
                <ul className="mt-1 space-y-0.5">
                  {items.map((item) => (
                    <li
                      key={`${item.kind}:${item.id}`}
                      className="flex min-w-0 items-center gap-2 text-[10px]"
                      title={item.id}
                    >
                      <span className="min-w-0 flex-1 truncate text-foreground/80">
                        {item.label}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground/70">
                        ×{item.callCount}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
