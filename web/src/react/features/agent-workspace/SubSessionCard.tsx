import { ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { useLocale } from "../../../hooks/useLocale";
import { ActivityStatus } from "../../components/beautiful-ui/ActivityStatus";
import type { AgentSession } from "../../../lib/api/agentRuntime";
import { activityPreview } from "./activityText";

interface Props {
  session: AgentSession;
  onExpand?: (sessionId: string) => void;
}

export function SubSessionCard({ session, onExpand }: Props) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const resultId = useId();
  const title = activityPreview(session.title?.trim() || session.prompt);

  return (
    <div className="bui-task" data-task-status={session.status}>
      <div className="bui-task-header">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="bui-task-trigger"
          aria-expanded={expanded}
          aria-controls={expanded ? resultId : undefined}
        >
          <span className="bui-task-copy">
            <span className="bui-task-profile">{session.profileId}</span>
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
      </div>
      {expanded && (
        <div id={resultId} className="bui-task-body">
          {session.resultSummary ? (
            <p className="whitespace-pre-wrap">{session.resultSummary}</p>
          ) : session.status === "running" ? (
            <p>{t("subSessionRunning")}</p>
          ) : (
            <p>{t("subSessionNoResult")}</p>
          )}
        </div>
      )}
    </div>
  );
}
