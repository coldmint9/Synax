import { ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useLocale } from "../../shared/hooks/useLocale";
import { ActivityStatus } from "../../shared/ui/beautiful-ui/ActivityStatus";
import type { AgentSession } from "../../adapters/transport/agentRuntime";
import { subagentTaskTitle } from "./subagentTaskTitle";
import { SubagentControls } from "./SubagentControls";
import { SubagentIdentity } from "./SubagentIdentity";

interface Props {
  session: AgentSession;
  onExpand?: (sessionId: string) => void;
}

export function SubSessionCard({ session, onExpand }: Props) {
  const { t, locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const resultId = useId();
  const title = subagentTaskTitle(session, locale);

  // A reused card instance keeps its expansion and its `aria-controls` target
  // across children, so session-derived state has to reset with the session.
  useEffect(() => {
    setExpanded(false);
  }, [session.id]);

  return (
    <div className="bui-task subagent-task-card" data-task-status={session.status}>
      <div className="bui-task-header">
        <div className="bui-task-trigger">
          <SubagentIdentity session={session} />
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="subagent-task-toggle"
            aria-expanded={expanded}
            aria-controls={expanded ? resultId : undefined}
          >
            <span className="bui-task-copy">
              <span className="bui-task-title" title={title}>
                {title}
              </span>
            </span>
            <ActivityStatus status={session.status} />
            {expanded ? (
              <ChevronDown size={12} className="bui-chevron" aria-hidden="true" />
            ) : (
              <ChevronRight
                size={12}
                className="bui-chevron"
                aria-hidden="true"
              />
            )}
          </button>
        </div>
        {onExpand && (
          <button
            type="button"
            onClick={() => onExpand(session.id)}
            className="bui-task-open"
          >
            {t("subSessionDetails")}
            <ArrowUpRight size={11} aria-hidden="true" />
          </button>
        )}
        <SubagentControls
          sessionId={session.id}
          parentSessionId={session.parentSessionId}
          status={session.status}
          title={title}
        />
      </div>
      {expanded && (
        <div id={resultId} className="bui-task-body subagent-task-result">
          {session.resultSummary ? (
            <p className="subagent-task-summary whitespace-pre-wrap">{session.resultSummary}</p>
          ) : session.status === "running" ? (
            <p className="subagent-task-badge">{t("subSessionRunning")}</p>
          ) : (
            <p className="subagent-task-summary">{t("subSessionNoResult")}</p>
          )}
        </div>
      )}
    </div>
  );
}
