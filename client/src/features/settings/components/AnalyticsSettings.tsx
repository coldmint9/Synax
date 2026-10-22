import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  RefreshCw,
  Wrench,
} from "lucide-react";
import {
  agentRuntimeApi,
  type ProjectAnalytics,
  type ProjectAnalyticsSession,
  type SessionInvocationUsageResponse,
  type SessionStats,
} from "../../../adapters/transport/agentRuntime";
import { formatContextLimit, formatTokenCount } from "../../../shared/lib/formatTokens";
import { useLocale } from "../../../shared/hooks/useLocale";
import { SessionCacheCard } from "../../agent-workspace/SessionCacheCard";
import { SessionInvocationUsagePanel } from "../../agent-workspace/SessionInvocationUsagePanel";
import "./analyticsSettings.css";

const CATEGORY_STYLES = [
  { key: "messages", color: "var(--analytics-messages)" },
  { key: "tools", color: "var(--analytics-tools)" },
  { key: "mcp", color: "var(--analytics-mcp)" },
  { key: "skills", color: "var(--analytics-skills)" },
  { key: "system", color: "var(--analytics-system)" },
] as const;

const percent = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;

const share = (value: number, total: number) =>
  total > 0 ? (value / total) * 100 : 0;

function CompositionDonut({
  composition,
}: {
  composition: ProjectAnalytics["totals"]["composition"];
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const total = composition.total;
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = CATEGORY_STYLES.flatMap((category) => {
    const value = composition[category.key];
    if (value <= 0 || total <= 0) return [];
    const length = (value / total) * circumference;
    const segment = { ...category, value, length, offset };
    offset += length;
    return [segment];
  });
  const labels: Record<string, [string, string]> = {
    messages: ["消息", "Messages"],
    tools: ["工具", "Tools"],
    mcp: ["MCP", "MCP"],
    skills: ["技能", "Skills"],
    system: ["系统提示词", "System prompt"],
  };
  return (
    <div className="analytics-donut">
      <svg viewBox="0 0 100 100" role="img" aria-label={zh ? "上下文分类占比" : "Context composition"}>
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          strokeWidth="10"
          className="analytics-donut__track"
        />
        {segments.map((segment) => (
          <circle
            key={segment.key}
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={segment.color}
            strokeWidth="10"
            strokeDasharray={`${segment.length} ${circumference}`}
            strokeDashoffset={-segment.offset}
            transform="rotate(-90 50 50)"
          />
        ))}
      </svg>
      <div className="analytics-donut__center">
        <span>{zh ? "合计" : "Total"}</span>
        <strong>{formatTokenCount(total)}</strong>
      </div>
      <ul className="analytics-legend">
        {CATEGORY_STYLES.map((category) => {
          const value = composition[category.key];
          return (
            <li key={category.key}>
              <span className="analytics-legend__dot" style={{ background: category.color }} />
              <span className="analytics-legend__label">
                {zh ? labels[category.key][0] : labels[category.key][1]}
              </span>
              <span className="analytics-legend__value">{formatTokenCount(value)}</span>
              <span className="analytics-legend__share">{share(value, total).toFixed(1)}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  trend,
}: {
  label: string;
  value: string;
  hint?: string;
  trend?: "up" | "down";
}) {
  return (
    <div className="analytics-kpi">
      <span className="analytics-kpi__label">{label}</span>
      <strong className="analytics-kpi__value">
        {value}
        {trend === "up" && <ArrowUpRight size={13} aria-hidden />}
        {trend === "down" && <ArrowDownRight size={13} aria-hidden />}
      </strong>
      {hint && <span className="analytics-kpi__hint">{hint}</span>}
    </div>
  );
}

function SessionStatus({ status }: { status: ProjectAnalyticsSession["status"] }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const labels: Record<string, string> = zh
    ? {
        running: "运行中",
        queued: "排队中",
        waiting_permission: "待确认",
        waiting_input: "待输入",
        stopping: "停止中",
        paused: "已暂停",
        completed: "已完成",
        failed: "失败",
        interrupted: "已中断",
        cancelled: "已取消",
      }
    : {
        running: "Running",
        queued: "Queued",
        waiting_permission: "Approval",
        waiting_input: "Input",
        stopping: "Stopping",
        paused: "Paused",
        completed: "Completed",
        failed: "Failed",
        interrupted: "Interrupted",
        cancelled: "Cancelled",
      };
  return (
    <span className="analytics-status" data-status={status}>
      <span className="analytics-status__dot" aria-hidden />
      {labels[status] ?? status}
    </span>
  );
}

function SessionUsageBars({
  row,
  maxContext,
}: {
  row: ProjectAnalyticsSession;
  maxContext: number;
}) {
  const context = row.context;
  const limit = context?.limit ?? 0;
  const used = context?.total ?? 0;
  const percentUsed = context?.percent;
  const tone =
    percentUsed === null || percentUsed === undefined
      ? "normal"
      : percentUsed >= 85
        ? "danger"
        : percentUsed >= 70
          ? "warning"
          : "normal";
  return (
    <div className="analytics-session-usage">
      <div className="analytics-session-usage__track">
        <span
          data-tone={tone}
          style={{
            width: `${limit > 0 ? Math.min(100, (used / limit) * 100) : share(used, maxContext)}%`,
          }}
        />
      </div>
      <span className="analytics-session-usage__label">
        {context
          ? `${formatTokenCount(used)}${limit ? ` / ${formatContextLimit(limit)}` : ""}`
          : "—"}
      </span>
    </div>
  );
}

export function AnalyticsSettings({ projectId }: { projectId: string | null }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [data, setData] = useState<ProjectAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    stats: SessionStats;
    usage: SessionInvocationUsageResponse;
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const next = await agentRuntimeApi.getProjectAnalytics(projectId);
      setData(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setData(null);
    setSelectedId(null);
    setDetail(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    void load();
  }, [load, projectId]);

  // Legacy sessions are mirrored in small batches; keep polling until done.
  useEffect(() => {
    if (!data?.pendingBackfill) return;
    const timer = window.setTimeout(() => void load(), 3_000);
    return () => window.clearTimeout(timer);
  }, [data?.pendingBackfill, load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetail(null);
    Promise.all([
      agentRuntimeApi.getSessionStats(selectedId),
      agentRuntimeApi.getSessionInvocationUsage(selectedId),
    ])
      .then(([stats, usage]) => {
        if (!cancelled) setDetail({ stats, usage });
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selected = useMemo(
    () => data?.sessions.find((session) => session.id === selectedId) ?? null,
    [data, selectedId],
  );
  const maxContext = useMemo(
    () =>
      Math.max(1, ...(data?.sessions.map((session) => session.context?.total ?? 0) ?? [])),
    [data],
  );
  const maxModelTotal = useMemo(
    () => Math.max(1, ...(data?.models.map((model) => model.total) ?? [])),
    [data],
  );
  const maxToolCalls = useMemo(
    () => Math.max(1, ...(data?.tools.map((tool) => tool.calls) ?? [])),
    [data],
  );

  if (!projectId) {
    return (
      <p className="analytics-empty">
        {zh ? "请先在左侧选择一个项目，再查看数据统计。" : "Select a project to view analytics."}
      </p>
    );
  }

  return (
    <div className="analytics-page">
      <header className="analytics-header">
        <div>
          <h2>{zh ? "数据统计" : "Analytics"}</h2>
          <p>
            {zh
              ? "基于每个会话增量持久化的运行统计，分析上下文构成、模型与工具使用情况。"
              : "Incremental runtime statistics per session: context composition, models, tools and cache."}
          </p>
        </div>
        <div className="analytics-header__actions">
          {data && (
            <span className="analytics-header__time">
              {zh ? "更新于 " : "Updated "}
              {new Date(data.generatedAt).toLocaleTimeString(zh ? "zh-CN" : "en-US", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          )}
          <button
            type="button"
            className="analytics-refresh"
            onClick={() => void load()}
            disabled={loading}
            aria-label={zh ? "刷新统计" : "Refresh analytics"}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      {error && <p className="analytics-error" role="alert">{error}</p>}
      {!data && loading && (
        <p className="analytics-empty" role="status">
          {zh ? "正在汇总统计数据…" : "Aggregating analytics…"}
        </p>
      )}
      {data?.pendingBackfill ? (
        <p className="analytics-pending" role="status">
          {zh
            ? `正在为 ${data.pendingBackfill} 个历史会话建立增量统计，完成后会自动刷新。`
            : `Mirroring ${data.pendingBackfill} legacy sessions. This page refreshes automatically.`}
        </p>
      ) : null}

      {data && (
        <>
          <section className="analytics-kpis" aria-label={zh ? "总览" : "Overview"}>
            <Kpi
              label={zh ? "会话" : "Sessions"}
              value={String(data.totals.sessions)}
              hint={zh ? `${data.totals.activeSessions} 个进行中` : `${data.totals.activeSessions} active`}
            />
            <Kpi
              label={zh ? "上下文占用" : "Context usage"}
              value={percent(data.totals.context.percent)}
              hint={
                data.totals.context.windowTokens > 0
                  ? `${formatTokenCount(data.totals.context.totalTokens)} / ${formatContextLimit(data.totals.context.windowTokens)}`
                  : zh
                    ? "暂无测量"
                    : "No measurements"
              }
            />
            <Kpi
              label={zh ? "Token 用量" : "Tokens"}
              value={formatTokenCount(data.totals.tokens.total)}
              hint={zh
                ? `输入 ${formatTokenCount(data.totals.tokens.input)} · 输出 ${formatTokenCount(data.totals.tokens.output)}`
                : `In ${formatTokenCount(data.totals.tokens.input)} · Out ${formatTokenCount(data.totals.tokens.output)}`}
            />
            <Kpi
              label={zh ? "工具调用" : "Tool calls"}
              value={String(data.totals.toolCalls)}
              hint={zh
                ? `${data.totals.steps} 轮 · ${data.totals.completedRuns} 次完成`
                : `${data.totals.steps} rounds · ${data.totals.completedRuns} completed`}
            />
            <Kpi
              label={zh ? "缓存命中" : "Cache hit"}
              value={percent(
                data.totals.cache.ratio === null
                  ? null
                  : data.totals.cache.ratio * 100,
              )}
              hint={zh
                ? `${formatTokenCount(data.totals.cache.cacheReadTokens)} 缓存读取`
                : `${formatTokenCount(data.totals.cache.cacheReadTokens)} cache read`}
            />
          </section>

          <div className="analytics-grid">
            <section className="analytics-card analytics-card--composition">
              <div className="analytics-card__head">
                <h3>{zh ? "上下文构成" : "Context composition"}</h3>
                <span>
                  {zh
                    ? `${data.totals.context.measuredSessions} 个会话已测量`
                    : `${data.totals.context.measuredSessions} measured sessions`}
                </span>
              </div>
              {data.totals.composition.total > 0 ? (
                <CompositionDonut composition={data.totals.composition} />
              ) : (
                <p className="analytics-empty analytics-empty--inline">
                  {zh ? "暂无上下文测量数据" : "No context measurements yet"}
                </p>
              )}
            </section>

            <section className="analytics-card">
              <div className="analytics-card__head">
                <h3>{zh ? "模型分布" : "Model distribution"}</h3>
                <span>{data.models.length}</span>
              </div>
              {data.models.length === 0 ? (
                <p className="analytics-empty analytics-empty--inline">
                  {zh ? "暂无模型用量" : "No model usage yet"}
                </p>
              ) : (
                <ul className="analytics-bars">
                  {data.models.slice(0, 8).map((model) => (
                    <li key={model.model}>
                      <div className="analytics-bars__label">
                        <span>{model.model === "unknown" ? (zh ? "未标注" : "Unknown") : model.model}</span>
                        <span>
                          {formatTokenCount(model.total)} · {model.steps} {zh ? "轮" : "steps"}
                        </span>
                      </div>
                      <div className="analytics-bars__track">
                        <span
                          style={{
                            width: `${share(model.total, maxModelTotal)}%`,
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="analytics-card">
              <div className="analytics-card__head">
                <h3>{zh ? "工具调用分布" : "Tool usage"}</h3>
                <span><Wrench size={12} aria-hidden /> {data.totals.toolCalls}</span>
              </div>
              {data.tools.length === 0 ? (
                <p className="analytics-empty analytics-empty--inline">
                  {zh ? "暂无工具调用" : "No tool calls yet"}
                </p>
              ) : (
                <ul className="analytics-bars analytics-bars--tools">
                  {data.tools.map((tool) => (
                    <li key={tool.toolId}>
                      <div className="analytics-bars__label">
                        <span title={tool.toolId}>{tool.toolId}</span>
                        <span>{tool.calls}</span>
                      </div>
                      <div className="analytics-bars__track">
                        <span
                          style={{ width: `${share(tool.calls, maxToolCalls)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="analytics-card analytics-sessions">
            <div className="analytics-card__head">
              <h3>{zh ? "会话明细" : "Sessions"}</h3>
              <span><Activity size={12} aria-hidden /> {data.sessions.length}</span>
            </div>
            <div className="analytics-table" role="table" aria-label={zh ? "会话明细" : "Session details"}>
              <div className="analytics-table__row analytics-table__row--head" role="row">
                <span role="columnheader">{zh ? "会话" : "Session"}</span>
                <span role="columnheader">{zh ? "状态" : "Status"}</span>
                <span role="columnheader">{zh ? "上下文" : "Context"}</span>
                <span role="columnheader">{zh ? "轮次" : "Rounds"}</span>
                <span role="columnheader">{zh ? "工具" : "Tools"}</span>
                <span role="columnheader">{zh ? "缓存" : "Cache"}</span>
              </div>
              {data.sessions.map((row) => (
                <button
                  type="button"
                  key={row.id}
                  role="row"
                  className={`analytics-table__row${selectedId === row.id ? " is-selected" : ""}`}
                  onClick={() => setSelectedId(selectedId === row.id ? null : row.id)}
                  aria-expanded={selectedId === row.id}
                >
                  <span role="cell" className="analytics-table__session">
                    <span className="analytics-table__title">{row.title}</span>
                    <span className="analytics-table__meta">
                      {row.parentSessionId ? (zh ? "子代理 · " : "Subagent · ") : ""}
                      {row.model === "unknown" ? (zh ? "未标注模型" : "Unknown model") : row.model ?? (zh ? "无模型" : "No model")}
                    </span>
                  </span>
                  <span role="cell"><SessionStatus status={row.status} /></span>
                  <span role="cell">
                    <SessionUsageBars row={row} maxContext={maxContext} />
                  </span>
                  <span role="cell" className="analytics-table__number">{row.analytics?.steps ?? "—"}</span>
                  <span role="cell" className="analytics-table__number">{row.analytics?.toolCalls ?? "—"}</span>
                  <span role="cell" className="analytics-table__number">
                    {row.analytics && row.analytics.usage.input > 0
                      ? percent((row.analytics.usage.cacheRead / row.analytics.usage.input) * 100)
                      : "—"}
                  </span>
                </button>
              ))}
              {data.sessions.length === 0 && (
                <p className="analytics-empty analytics-empty--inline">
                  {zh ? "该项目还没有会话" : "This project has no sessions yet"}
                </p>
              )}
            </div>
          </section>

          {selected && (
            <section className="analytics-card analytics-detail" aria-label={zh ? "会话统计详情" : "Session analytics detail"}>
              <div className="analytics-card__head">
                <h3>{selected.title}</h3>
                <SessionStatus status={selected.status} />
              </div>
              {detailLoading ? (
                <p className="analytics-empty analytics-empty--inline" role="status">
                  {zh ? "正在读取会话统计…" : "Loading session statistics…"}
                </p>
              ) : detail ? (
                <div className="analytics-detail__grid">
                  <div className="analytics-detail__section">
                    <h4>{zh ? "运行概况" : "Runtime"}</h4>
                    <dl className="analytics-detail__facts">
                      <div><dt>{zh ? "运行轮次" : "Rounds"}</dt><dd>{detail.stats.roundCount ?? "—"}</dd></div>
                      <div><dt>{zh ? "平均每轮步数" : "Steps per run"}</dt><dd>{detail.stats.averageStepsPerCompletedRun?.toFixed(1) ?? "—"}</dd></div>
                      <div><dt>{zh ? "工具调用" : "Tool calls"}</dt><dd>{detail.usage.totalCalls ?? detail.stats.toolCallCount ?? "—"}</dd></div>
                      <div><dt>{zh ? "输入 Token" : "Input tokens"}</dt><dd>{formatTokenCount(detail.stats.usage?.self.input ?? 0)}</dd></div>
                      <div><dt>{zh ? "输出 Token" : "Output tokens"}</dt><dd>{formatTokenCount(detail.stats.usage?.self.output ?? 0)}</dd></div>
                      <div><dt>{zh ? "上下文" : "Context"}</dt><dd>
                        {selected.context
                          ? `${formatTokenCount(selected.context.total)}${selected.context.limit ? ` / ${formatContextLimit(selected.context.limit)}` : ""} · ${percent(selected.context.percent)}`
                          : "—"}
                      </dd></div>
                    </dl>
                    <SessionCacheCard cache={detail.stats.cache} />
                  </div>
                  <div className="analytics-detail__section analytics-detail__section--scroll">
                    <h4>{zh ? "调用分布" : "Invocations"}</h4>
                    <SessionInvocationUsagePanel usage={detail.usage} />
                  </div>
                </div>
              ) : (
                <p className="analytics-empty analytics-empty--inline">
                  {zh ? "暂无统计数据" : "No statistics available"}
                </p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
