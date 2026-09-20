import type {
  SessionCacheUsage,
  CacheUsageSummary,
} from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";

const percent = (ratio: number | null | undefined) =>
  typeof ratio === "number" &&
  Number.isFinite(ratio) &&
  ratio >= 0 &&
  ratio <= 1
    ? `${(ratio * 100).toFixed(1)}%`
    : "—";

export function SessionCacheCard({ cache }: { cache?: SessionCacheUsage }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const latest = cache?.latest;
  const coverage = (summary?: CacheUsageSummary) =>
    summary ? `${summary.matched}/${summary.samples}` : "0/0";
  const rows = [
    {
      label: zh
        ? latest?.unit === "external-turn"
          ? "最近回合缓存率"
          : "最近一次缓存率"
        : "Latest cache hit rate",
      ratio: latest?.ratio,
    },
    {
      label: zh ? "平均缓存率（逐轮）" : "Average cache hit rate (per request)",
      ratio: cache?.session.ratio,
      summary: cache?.session,
    },
  ];
  return (
    <section
      aria-label={zh ? "API 缓存统计" : "API cache statistics"}
      className="space-y-1 text-[9px] text-muted-foreground"
    >
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-center justify-between gap-2"
        >
          <span>{row.label}</span>
          <span className="tabular-nums text-foreground/80">
            {percent(row.ratio)}
            {row.summary && row.summary.matched < row.summary.samples && (
              <span className="ml-1 text-muted-foreground/60">
                {zh ? "部分数据" : "Partial"} {coverage(row.summary)}
              </span>
            )}
          </span>
        </div>
      ))}
      {!!cache?.pending && (
        <p>
          {zh
            ? `${cache.pending} 个请求等待 usage`
            : `${cache.pending} requests awaiting usage`}
        </p>
      )}
    </section>
  );
}
