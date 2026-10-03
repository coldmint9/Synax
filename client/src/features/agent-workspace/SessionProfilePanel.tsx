import { memo, useId } from "react";
import { ChevronDown, CircleAlert, Gauge } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type {
  AgentRun,
  AgentRunStep,
  ContextComposition,
} from "../../adapters/transport/agentRuntime";
import {
  formatContextLimit,
  formatTokenCount,
  formatTokenRate,
} from "../../shared/lib/formatTokens";
import { useLocale } from "../../shared/hooks/useLocale";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { SessionInvocationUsagePanel } from "./SessionInvocationUsagePanel";
import { SessionCacheCard } from "./SessionCacheCard";
import { sessionRuntimeSelection } from "./sessionRuntimeSelection";
import { sessionCompaction } from "./sessionCompaction";
import { readSessionBackendId } from "./synaxSessionTypes";
import { splitProviderModel, useProviderNames } from "./useProviderNames";
import { useWorkspaceDisclosure } from "./useWorkspaceDisclosure";
import { runtimeProfileSummary } from "./runtimeProfileSummary";
import { useSessionTokenRate } from "./useSessionTokenRate";
import "./sessionProfilePanel.css";

const EMPTY_STEPS: AgentRunStep[] = [];
const EMPTY_RUNS: AgentRun[] = [];

export const SessionProfilePanel = memo(function SessionProfilePanel({
  sessionId,
}: {
  sessionId: string | null;
}) {
  return sessionId ? (
    <RuntimeProfile key={sessionId} sessionId={sessionId} />
  ) : null;
});

function readContextComposition(
  stats: {
    contextComposition?: ContextComposition | null;
    context?: { requestId: string | null };
  } | null,
  steps: AgentRunStep[],
): ContextComposition | null {
  if (stats?.contextComposition) return stats.contextComposition;
  if (stats?.context?.requestId) {
    const matchingStep = steps.find(
      (step) => step.id === stats.context?.requestId,
    );
    const composition = matchingStep?.metadata?.contextComposition;
    return composition && typeof composition === "object"
      ? (composition as ContextComposition)
      : null;
  }
  for (const step of [...steps].sort((a, b) => b.index - a.index)) {
    const composition = step.metadata?.contextComposition;
    if (composition && typeof composition === "object")
      return composition as ContextComposition;
  }
  return null;
}

const COMPOSITION_COLORS = {
  messages: "var(--profile-messages)",
  tools: "var(--profile-tools)",
  mcp: "var(--profile-mcp)",
  skills: "var(--profile-skills)",
} as const;

const COMPOSITION_LABELS = {
  messages: { zh: "消息", en: "Messages" },
  tools: { zh: "工具", en: "Tools" },
  mcp: { zh: "MCP", en: "MCP" },
  skills: { zh: "Skill", en: "Skills" },
} as const;

function ContextCompositionMeter({
  composition,
  percent,
  label,
  valueText,
  zh,
}: {
  composition: ContextComposition | null;
  percent: number | null;
  label: string;
  valueText: string;
  zh: boolean;
}) {
  const total = composition?.total;
  const validTotal =
    typeof total === "number" && Number.isFinite(total) && total > 0;
  const values = validTotal && composition
    ? (["messages", "tools", "mcp", "skills"] as const)
        .map((kind) => ({ kind, value: Number(composition[kind] ?? 0) }))
        .filter((item) => Number.isFinite(item.value) && item.value > 0)
    : [];
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const categoryTotal = values.reduce((sum, item) => sum + item.value, 0);
  const segmented = categoryTotal > 0 && validTotal && categoryTotal <= total;
  const categoryHint = zh
    ? "颜色段为分类估算；未着色部分包含系统提示词等未单独展示内容。"
    : "Colored segments are category estimates; the uncolored portion includes system prompts and other content not shown separately.";

  return (
    <div
      className={`runtime-profile-meter${segmented ? " runtime-profile-meter--segmented" : ""}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={width}
      aria-valuetext={`${valueText} · ${categoryHint}`}
      title={categoryHint}
    >
      <div
        className={`runtime-profile-meter-fill${segmented ? "" : " runtime-profile-meter-fill--fallback"}`}
        style={{ width: `${width}%` }}
      >
        {segmented &&
          values.map(({ kind, value }) => (
            <span
              key={kind}
              data-context-category={kind}
              title={`${COMPOSITION_LABELS[kind][zh ? "zh" : "en"]}: ${value.toLocaleString()} ${zh ? "Token（分类估算）" : "tokens (category estimate)"}`}
              style={{
                width: `${(value / total) * 100}%`,
                background: COMPOSITION_COLORS[kind],
              }}
            />
          ))}
      </div>
    </div>
  );
}

function RuntimeProfile({ sessionId }: { sessionId: string }) {
  const zh = useLocale().locale === "zh";
  const providers = useProviderNames();
  const [open, toggle] = useWorkspaceDisclosure(`${sessionId}:runtime`, false);
  const id = useId();
  const { loading, stats, usage, steps, runs, session } = useAgentSessionStore(
    useShallow((s) => {
      const selected = s.selectedSessionId === sessionId;
      return {
        loading: selected && s.detailLoading,
        stats: selected ? s.sessionStats : null,
        usage: selected ? s.sessionInvocationUsage : null,
        steps: selected ? s.steps : EMPTY_STEPS,
        runs: selected ? s.runs : EMPTY_RUNS,
        session: s.sessions.find((item) => item.id === sessionId),
      };
    }),
  );
  const runtime = sessionRuntimeSelection(session, runs, steps);
  const liveCompaction = useAgentSessionStore(
    (state) =>
      state.selectedSessionId === sessionId &&
      state.contextCompactionNotice?.status === "running",
  );
  const compacting =
    sessionCompaction(session)?.status === "running" || liveCompaction;
  const summary = compacting
    ? {
        ...runtimeProfileSummary(stats, session?.status, zh),
        label: zh ? "压缩中" : "Compacting",
        tone: "running",
      }
    : runtimeProfileSummary(stats, session?.status, zh);
  const composition = readContextComposition(stats, steps);
  const compositionLabel = zh ? "上下文类型占比" : "Context composition";
  const title = zh ? "运行详情" : "Runtime details";
  const model = splitProviderModel(runtime.model, providers);
  const modelName = model.model ?? (zh ? "模型待定" : "Model not set");
  const providerName = model.provider;
  const pending = loading && !stats && !usage;
  const count = usage?.totalCalls ?? stats?.toolCallCount;
  const calls =
    typeof count === "number" && Number.isFinite(count) && count >= 0
      ? count
      : null;
  // Measured in the renderer from the stream; an idle session keeps no timer.
  const rate = useSessionTokenRate(sessionId, summary.tone === "running");
  const rateLabel = rate === null ? "—" : formatTokenRate(rate);
  const rateTitle =
    rate === null
      ? zh
        ? "会话未在生成输出，不做统计"
        : "Not sampling while the session is idle"
      : zh
        ? "最近 5 秒的实时估算：流式输出 tokens ÷ 用时（含思考内容）"
        : "Live estimate over the last 5s: streamed output tokens ÷ elapsed (includes reasoning)";
  const tokenLabel = summary.available ? formatTokenCount(summary.total) : "—";
  const percentLabel =
    summary.percent === null ? null : `${Number(summary.percent.toFixed(1))}%`;
  const backend = session ? readSessionBackendId(session) : null;
  const description = [
    providerName ? `${providerName}/${modelName}` : modelName,
    summary.label,
    summary.stale
      ? zh
        ? "上次上下文"
        : "Last context"
      : zh
        ? "上下文"
        : "Context",
    tokenLabel,
    summary.limit !== null ? `/ ${formatContextLimit(summary.limit)}` : "",
    rate === null
      ? ""
      : zh
        ? `约 ${rateLabel} tokens/秒`
        : `~${rateLabel} tokens/s`,
    calls !== null ? `${calls} ${zh ? "次调用" : "calls"}` : "",
    summary.hint,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="work-runtime-details runtime-profile">
      <section
        className="ws-card runtime-profile-card"
        data-open={String(open)}
        aria-label={title}
      >
        <div className="ws-card-head runtime-profile-head">
          <button
            type="button"
            className="runtime-profile-toggle"
            aria-label={title}
            aria-describedby={`${id}-summary`}
            aria-expanded={open}
            aria-controls={`${id}-detail`}
            onClick={toggle}
          >
            <span id={`${id}-summary`} className="sr-only">
              {description}
            </span>
            <span className="runtime-profile-line">
              <span
                className="runtime-profile-model"
                title={runtime.model ?? undefined}
              >
                {modelName}
              </span>
              <span className="runtime-profile-status" data-tone={summary.tone}>
                <span className="runtime-profile-dot" aria-hidden="true" />
                {summary.label}
              </span>
              <ChevronDown
                size={14}
                className="runtime-profile-chevron"
                aria-hidden="true"
              />
            </span>
            <span className="runtime-profile-metrics">
              <span
                className="runtime-profile-context-value"
                title={
                  summary.reported
                    ? zh
                      ? "最近一次供应商返回的完整输入 Token（含缓存），不是会话累计用量"
                      : "Last provider-reported input tokens including cache, not cumulative usage"
                    : zh
                      ? "暂无供应商数据"
                      : "No provider usage available"
                }
              >
                <span className="runtime-profile-value">
                  {pending ? (zh ? "加载中" : "Loading") : tokenLabel}
                </span>
                {summary.limit !== null && (
                  <span className="runtime-profile-limit">
                    {` / ${formatContextLimit(summary.limit)}`}
                  </span>
                )}
              </span>
              <span className="runtime-profile-rate" title={rateTitle}>
                <Gauge size={11} aria-hidden="true" />
                <span className="runtime-profile-value">{rateLabel}</span>
                <span>tokens/s</span>
              </span>
            </span>
            {summary.hint && (
              <span
                className="runtime-profile-hint"
                data-tone={summary.hintTone}
              >
                <CircleAlert size={12} aria-hidden="true" />
                <span>
                  {summary.hint}
                  {summary.high && !["warning", "danger"].includes(summary.tone)
                    ? ` · ${percentLabel}`
                    : ""}
                </span>
              </span>
            )}
          </button>
          {summary.percent !== null && (
            <ContextCompositionMeter
              composition={composition}
              percent={summary.percent}
              label={compositionLabel}
              valueText={`${summary.stale ? (zh ? "上次记录 · " : "Last sample · ") : ""}${tokenLabel}${summary.limit !== null ? ` / ${formatContextLimit(summary.limit)}` : ""} · ${percentLabel ?? "—"}`}
              zh={zh}
            />
          )}
        </div>
        {open && (
          <div
            id={`${id}-detail`}
            className="ws-card-body runtime-profile-body"
            aria-busy={pending}
          >
            {pending ? (
              <p className="runtime-profile-empty" role="status">
                {zh ? "正在加载运行数据…" : "Loading runtime data…"}
              </p>
            ) : (
              <>
                {stats && (
                  <>
                    <div className="runtime-profile-performance">
                      <dl className="runtime-profile-properties">
                        <dt>{zh ? "运行轮次" : "Execution rounds"}</dt>
                        <dd>{stats.roundCount ?? steps.length}</dd>
                      </dl>
                      <dl className="runtime-profile-properties">
                        <dt>{zh ? "工具调用" : "Tool calls"}</dt>
                        <dd>{calls ?? "—"}</dd>
                      </dl>
                      <SessionCacheCard cache={stats.cache} />
                      {stats.activeSubAgentCount > 0 && (
                        <dl className="runtime-profile-properties">
                          <dt>{zh ? "运行中子代理" : "Active subagents"}</dt>
                          <dd>{stats.activeSubAgentCount}</dd>
                        </dl>
                      )}
                    </div>
                  </>
                )}
                {usage && (
                  <div className="runtime-profile-invocations">
                    <SessionInvocationUsagePanel usage={usage} />
                  </div>
                )}
                {!stats && !usage && (
                  <p className="runtime-profile-empty">
                    {zh ? "暂无运行数据" : "No runtime data yet"}
                  </p>
                )}
                {(providerName || backend || runtime.reasoningEffort) && (
                  <dl className="runtime-profile-properties runtime-profile-footer">
                    {providerName && (
                      <>
                        <dt>{zh ? "供应商" : "Provider"}</dt>
                        <dd>{providerName}</dd>
                      </>
                    )}
                    {backend && (
                      <>
                        <dt>{zh ? "执行环境" : "Execution backend"}</dt>
                        <dd>{backend}</dd>
                      </>
                    )}
                    {runtime.reasoningEffort && (
                      <>
                        <dt>{zh ? "推理强度" : "Reasoning effort"}</dt>
                        <dd>{runtime.reasoningEffort}</dd>
                      </>
                    )}
                  </dl>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
