import type { SessionCacheUsage, CacheUsageSummary } from '../../../lib/api/agentRuntime'
import { useLocale } from '../../../hooks/useLocale'

const percent = (ratio: number | null | undefined) =>
  typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
    ? `${(ratio * 100).toFixed(1)}%` : '—'

export function SessionCacheCard({ cache }: { cache?: SessionCacheUsage }) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const latest = cache?.latest
  const coverage = (summary?: CacheUsageSummary) => summary
    ? `${summary.matched}/${summary.samples}` : '0/0'
  const rows = [
    { label: zh ? (latest?.unit === 'external-turn' ? '最近回合缓存率' : '最近一次缓存率') : 'Latest cache hit rate', ratio: latest?.ratio },
    { label: zh ? '最近 10 次平均' : 'Last 10 average', ratio: cache?.recent.ratio, summary: cache?.recent },
    { label: zh ? '平均缓存率（逐轮）' : 'Average cache hit rate (per request)', ratio: cache?.session.ratio, summary: cache?.session },
  ]
  return <section aria-label={zh ? 'API 缓存统计' : 'API cache statistics'} className="space-y-1 text-[9px] text-muted-foreground">
    {rows.map(row => <div key={row.label} className="flex items-center justify-between gap-2">
      <span>{row.label}</span>
      <span className="tabular-nums text-foreground/80">{percent(row.ratio)}
        {row.summary && row.summary.matched < row.summary.samples && <span className="ml-1 text-muted-foreground/60">{zh ? '部分数据' : 'Partial'} {coverage(row.summary)}</span>}
      </span>
    </div>)}
    {!!cache?.pending && <p>{zh ? `${cache.pending} 个请求等待 usage` : `${cache.pending} requests awaiting usage`}</p>}
    <details>
      <summary className="cursor-pointer">{zh ? 'API 返回值与计算依据' : 'API values and calculation'}</summary>
      <div className="mt-1 space-y-1 break-words">
        <p>{zh ? '数据来自当前服务商/网关返回的 usage；无法独立验证网关上游。' : 'Usage reported by the configured provider/gateway; upstream values are not independently verified.'}</p>
        <p>{zh ? '每轮命中率 = 本轮缓存读取 Token ÷ 本轮完整输入 Token；平均缓存率 = 有效轮次命中率之和 ÷ 有效轮次数。仅本会话，不含子 Agent 和辅助调用。' : 'Per-request rate = cache-read tokens / full input tokens. Average = sum of valid request rates / number of valid requests. This session only; excludes child agents and auxiliary calls.'}</p>
        <p>{zh ? '未知、异常、零输入及 CLI 整回合汇总不计入逐轮平均，真实零命中计入。' : 'Unknown, invalid, zero-input and aggregated CLI turns excluded from per-request averages; reported zero hits included.'}</p>
        {cache && <p>{zh ? '会话合计' : 'Session totals'}: {cache.session.cacheReadTokens.toLocaleString(locale)} / {cache.session.inputTokens.toLocaleString(locale)} tokens · {zh ? '有效记录' : 'Valid records'} {coverage(cache.session)}</p>}
        {cache && <p>{zh ? 'Token 加权命中率（辅助指标）' : 'Token-weighted hit rate (secondary)'}: {percent(cache.session.weightedRatio)}</p>}
        {cache && <p>{zh ? '最近有效记录' : 'Recent valid records'}: {coverage(cache.recent)}</p>}
        {latest && <p>{zh ? '最近记录时间' : 'Latest record time'}: {latest.measuredAt}</p>}
        {latest && <p>{zh ? '字段' : 'Fields'}: {latest.inputSource} / {latest.cacheSource}</p>}
        {!!cache?.recentSamples.length && <table className="w-full table-fixed text-right tabular-nums">
          <thead><tr><th className="text-left">{zh ? '最近记录' : 'Recent'}</th><th>{zh ? '输入' : 'Input'}</th><th>{zh ? '命中' : 'Cached'}</th><th>{zh ? '命中率' : 'Rate'}</th></tr></thead>
          <tbody>{cache.recentSamples.map((sample, index) => <tr key={sample.stepId} title={`${sample.measuredAt} · ${sample.model ?? '—'} · ${sample.stepId} · ${sample.cacheSource}`}>
            <td className="text-left">{index === 0 ? (zh ? '最近' : 'Latest') : `−${index}`}{sample.status === 'invalid' ? (zh ? ' 异常' : ' Invalid') : ''}</td>
            <td>{sample.inputTokens?.toLocaleString(locale) ?? '—'}</td><td>{sample.cacheReadTokens?.toLocaleString(locale) ?? '—'}</td><td>{percent(sample.ratio)}</td>
          </tr>)}</tbody>
        </table>}
      </div>
    </details>
  </section>
}
