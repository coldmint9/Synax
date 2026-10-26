import { useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { agentRuntimeApi, type AgentRuntimeMessage, type AgentSession } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import { buildSubagentInteractions, isSubagentActive, type SubagentInteraction } from "./subagentInteractions";

const REFRESH_MS = 4000;
const PREVIEW_COUNT = 6;
const PREVIEW_LENGTH = 280;
const LABELS = {
  assignment: ["任务委派", "Assignment"],
  instruction: ["补充指令", "Follow-up"],
  progress: ["进展反馈", "Progress"],
  result: ["结果回报", "Result"],
  blocked: ["阻塞原因", "Blocker"],
} as const;

function InteractionItem({ item, zh }: { item: SubagentInteraction; zh: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const fromParent = item.kind === "assignment" || item.kind === "instruction";
  const long = item.content.length > PREVIEW_LENGTH;
  const date = new Date(item.createdAt);
  const validDate = Number.isFinite(date.getTime());
  return (
    <li className="subagent-exchange" data-direction={fromParent ? "parent" : "child"}>
      <span className="subagent-exchange-icon" aria-hidden="true">
        {fromParent ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
      </span>
      <div className="subagent-exchange-copy">
        <div className="subagent-exchange-heading">
          <span className="subagent-exchange-direction">{fromParent
            ? (zh ? "主代理 → 子代理" : "Parent → Subagent")
            : (zh ? "子代理 → 主代理" : "Subagent → Parent")}</span>
          <span className="subagent-exchange-kind">{LABELS[item.kind][zh ? 0 : 1]}</span>
          {validDate && <time dateTime={item.createdAt} title={date.toLocaleString(zh ? "zh-CN" : "en-US")}>
            {date.toLocaleTimeString(zh ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
          </time>}
        </div>
        <p className="subagent-exchange-content">{long && !expanded ? `${item.content.slice(0, PREVIEW_LENGTH).trimEnd()}…` : item.content}</p>
        {long && <button type="button" className="subagent-exchange-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? (zh ? "收起内容" : "Show less") : (zh ? "展开内容" : "Show more")}
        </button>}
      </div>
    </li>
  );
}

export function SubagentInteractionSummary({ session }: { session: AgentSession }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [snapshot, setSnapshot] = useState<{ session: AgentSession; messages: AgentRuntimeMessage[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let active = isSubagentActive(session.status);
      try {
        const [detail, messages] = await Promise.all([
          agentRuntimeApi.getSessionSummary(session.id),
          agentRuntimeApi.listMessages(session.id),
        ]);
        if (disposed) return;
        active = isSubagentActive(detail.session.status);
        setSnapshot({ session: detail.session, messages: messages.items });
        setFailed(false);
      } catch {
        if (disposed) return;
        setFailed(true);
      } finally {
        if (!disposed) {
          setLoading(false);
          if (active) timer = setTimeout(() => void load(), REFRESH_MS);
        }
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [session.id, session.status, session.updatedAt, retry]);

  const current = snapshot && snapshot.session.updatedAt >= session.updatedAt ? snapshot.session : session;
  const interactions = buildSubagentInteractions(current, snapshot?.messages ?? []);
  // Keep the assignment in view alongside the latest exchanges.
  const hiddenCount = Math.max(0, interactions.length - PREVIEW_COUNT);
  const visible = showAll || !hiddenCount ? interactions : [interactions[0], ...interactions.slice(-(PREVIEW_COUNT - 1))];
  const hasFeedback = interactions.some((item) => item.kind === "progress" || item.kind === "result" || item.kind === "blocked");

  return (
    <section className="subagent-interactions" aria-label={zh ? "主子代理交互摘要" : "Parent and subagent interaction summary"}>
      <div className="subagent-interactions-heading">
        <strong>{zh ? "交互摘要" : "Interaction summary"}</strong>
        <span>{zh ? `${interactions.length} 条` : `${interactions.length} exchanges`}</span>
      </div>
      {hiddenCount > 0 && <button type="button" className="subagent-exchange-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
        {showAll ? (zh ? "只看最近交互" : "Show recent exchanges") : (zh ? `查看更早的 ${hiddenCount} 条交互` : `Show ${hiddenCount} earlier exchanges`)}
      </button>}
      <ol className="subagent-exchanges">
        {visible.map((item) => <InteractionItem key={item.id} item={item} zh={zh} />)}
      </ol>
      {failed ? <div className="subagent-interactions-notice" role="status">
        <span>{zh ? "交互记录暂时无法更新，已保留当前内容。" : "Could not refresh exchanges. Available content is preserved."}</span>
        <button type="button" className="subagent-exchange-more" onClick={() => setRetry((value) => value + 1)}>{zh ? "重试" : "Retry"}</button>
      </div> : loading ? <p className="subagent-interactions-notice" role="status">{zh ? "正在加载交互记录…" : "Loading exchanges…"}</p>
        : !hasFeedback && <p className="subagent-interactions-notice">{isSubagentActive(current.status)
          ? (zh ? "任务已下发，等待子代理反馈。" : "Task assigned. Waiting for the subagent’s first update.")
          : (zh ? "暂无子代理反馈记录。" : "No subagent feedback recorded.")}</p>}
    </section>
  );
}
