import { memo, useId } from "react";
import { ChevronDown, CircleAlert, Wrench } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { AgentRun, AgentRunStep } from "../../../lib/api/agentRuntime";
import {
  formatContextLimit,
  formatTokenCount,
} from "../../../lib/formatTokens";
import { useLocale } from "../../../hooks/useLocale";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { SessionInvocationUsagePanel } from "./SessionInvocationUsagePanel";
import { ContextCompositionBar } from "./ContextCompositionBar";
import { SessionCacheCard } from "./SessionCacheCard";
import { sessionRuntimeSelection } from "./sessionRuntimeSelection";
import { readSessionBackendId } from "./synaxSessionTypes";
import { formatModelDisplayName, useProviderNames } from "./useProviderNames";
import { useWorkspaceDisclosure } from "./useWorkspaceDisclosure";
import { runtimeProfileSummary } from "./runtimeProfileSummary";
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
  const summary = runtimeProfileSummary(stats, session?.status, zh);
  const title = zh ? "运行详情" : "Runtime details";
  const model =
    formatModelDisplayName(runtime.model, providers) ??
    (zh ? "模型待定" : "Model not set");
  const pending = loading && !stats && !usage;
  const count = usage?.totalCalls ?? stats?.toolCallCount;
  const calls =
    typeof count === "number" && Number.isFinite(count) && count >= 0
      ? count
      : null;
  const tokenLabel = summary.available ? formatTokenCount(summary.total) : "—";
  const percentLabel =
    summary.percent === null ? null : `${Number(summary.percent.toFixed(1))}%`;
  const backend = session ? readSessionBackendId(session) : null;
  const description = [
    model,
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
                {model}
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
              <span className="runtime-profile-context-label">
                {summary.stale
                  ? zh
                    ? "上次上下文"
                    : "Last context"
                  : zh
                    ? "上下文"
                    : "Context"}
              </span>
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
                {summary.available && summary.limit !== null && (
                  <span className="runtime-profile-limit">
                    {" "}
                    / {formatContextLimit(summary.limit)}
                  </span>
                )}
              </span>
              <span className="runtime-profile-calls">
                <Wrench size={11} aria-hidden="true" />
                <span className="runtime-profile-value">{calls ?? "—"}</span>
                <span>
                  {usage
                    ? zh
                      ? "次调用"
                      : "calls"
                    : zh
                      ? "次工具调用"
                      : "tool calls"}
                </span>
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
            <div
              className="runtime-profile-meter"
              data-high={summary.high}
              data-stale={summary.stale}
              role="meter"
              aria-label={zh ? "上下文使用率" : "Context usage"}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, Number(summary.percent.toFixed(1)))}
              aria-valuetext={`${summary.stale ? (zh ? "上次记录 · " : "Last sample · ") : ""}${tokenLabel} / ${formatContextLimit(summary.limit!)} · ${percentLabel}`}
            >
              <span style={{ width: `${Math.min(100, summary.percent)}%` }} />
            </div>
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
                    <div className="runtime-profile-context">
                      <ContextCompositionBar
                        context={stats.context}
                        contextLimit={stats.contextLimit}
                        contextLimitKnown={stats.contextLimitKnown !== false}
                      />
                    </div>
                    <div className="runtime-profile-performance">
                      <dl className="runtime-profile-properties">
                        <dt>{zh ? "运行轮次" : "Execution rounds"}</dt>
                        <dd>{stats.roundCount ?? steps.length}</dd>
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
                {(backend || runtime.reasoningEffort) && (
                  <dl className="runtime-profile-properties runtime-profile-footer">
                    {backend && (
                      <>
                        <dt>{zh ? "执行环境" : "Execution backend"}</dt>
                        <dd>
                          {backend === "native" ? "Synax · Native" : backend}
                        </dd>
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
