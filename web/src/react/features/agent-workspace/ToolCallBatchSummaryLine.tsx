import { useId, useMemo, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import { ActivityStatus } from "../../components/beautiful-ui/ActivityStatus";
import { ToolCallSummaryLine } from "./ToolCallSummaryLine";
import {
  aggregateToolStatus,
  toolCallPresentation,
} from "./toolCallPresentation";
import type { ToolCallBatch } from "./toolCallUtils";

interface Props {
  batch: ToolCallBatch;
}

export function ToolCallBatchSummaryLine({ batch }: Props) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { calls, toolId } = batch;
  const presentation = useMemo(() => toolCallPresentation(calls[0]), [calls]);
  const Icon = presentation.icon;
  const status = aggregateToolStatus(calls);

  if (calls.length === 1) return <ToolCallSummaryLine call={calls[0]} />;

  return (
    <div className="bui-tool" data-tool-status={status}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="bui-tool-trigger"
        aria-expanded={expanded}
        aria-controls={expanded ? detailsId : undefined}
      >
        <span className="bui-tool-symbol">
          <Icon size={13} aria-hidden="true" />
        </span>
        <span className="bui-tool-label" title={toolId}>
          {presentation.label ? t(presentation.label) : toolId}
        </span>
        <span className="bui-tool-count">×{calls.length}</span>
        {presentation.target && (
          <span className="bui-tool-target" title={presentation.target}>
            {presentation.target}
          </span>
        )}
        <span className="bui-tool-meta">
          <ActivityStatus status={status} compact={status === "completed"} />
          {expanded ? (
            <ChevronDown size={11} className="bui-chevron" aria-hidden="true" />
          ) : (
            <ChevronRight
              size={11}
              className="bui-chevron"
              aria-hidden="true"
            />
          )}
        </span>
      </button>
      {expanded && (
        <div id={detailsId} className="bui-tool-batch-body">
          {calls.map((call) => (
            <ToolCallSummaryLine key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}
