import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import { ActivityStatus } from "../../components/beautiful-ui/ActivityStatus";
import type { ToolCallView } from "./buildInterleavedTurns";
import { toolCallPresentation } from "./toolCallPresentation";

interface Props {
  call: ToolCallView;
}

export function ToolCallSummaryLine({ call }: Props) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const presentation = useMemo(
    () => toolCallPresentation(call),
    [call.toolId, call.category, call.inputSummary],
  );
  const Icon = presentation.icon;
  const hasDetails = Boolean(call.inputSummary || call.outputSummary);
  const heading = (
    <>
      <span className="bui-tool-symbol">
        <Icon size={13} aria-hidden="true" />
      </span>
      <span className="bui-tool-label" title={call.toolId}>
        {presentation.label ? t(presentation.label) : call.toolId}
      </span>
      {presentation.target && (
        <span className="bui-tool-target" title={presentation.target}>
          {presentation.target}
        </span>
      )}
      <span className="bui-tool-meta">
        {call.duration && <span>{call.duration}</span>}
        <ActivityStatus
          status={call.status}
          compact={call.status === "completed"}
        />
        {hasDetails &&
          (expanded ? (
            <ChevronDown size={11} className="bui-chevron" aria-hidden="true" />
          ) : (
            <ChevronRight
              size={11}
              className="bui-chevron"
              aria-hidden="true"
            />
          ))}
      </span>
    </>
  );

  return (
    <div className="bui-tool" data-tool-status={call.status}>
      {hasDetails ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          className="bui-tool-trigger"
        >
          {heading}
        </button>
      ) : (
        <div className="bui-tool-trigger">{heading}</div>
      )}
      {expanded && hasDetails && (
        <div id={detailsId} className="bui-tool-details">
          <div className="bui-tool-detail-label">{call.toolId}</div>
          {call.inputSummary && (
            <div>
              <div className="bui-tool-detail-label">
                {t("activityToolInput")}
              </div>
              <pre>{call.inputSummary}</pre>
            </div>
          )}
          {call.outputSummary && (
            <div>
              <div className="bui-tool-detail-label">
                {t("activityToolOutput")}
              </div>
              <pre>{call.outputSummary}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
