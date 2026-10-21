import { memo, useId, useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button as HeadlessButton } from "@headlessui/react";
import { useLocale } from "../../shared/hooks/useLocale";
import { ActivityStatus } from "../../shared/ui/beautiful-ui/ActivityStatus";
import type { ToolCallView } from "./buildInterleavedTurns";
import { toolCallPresentation } from "./toolCallPresentation";
import { activityPreview, latestActivityPreview } from "./activityText";
import { useActivityDisclosure } from "./useActivityDisclosure";
import { ExecutionProgressLabel } from "./ExecutionProgressLabel";

interface Props {
  call: ToolCallView;
  rememberKey?: string;
}

export const ToolCallSummaryLine = memo(function ToolCallSummaryLine({ call, rememberKey }: Props) {
  const { t, locale } = useLocale();
  const [expanded, toggle] = useActivityDisclosure(rememberKey ? `${rememberKey}:tool:${call.id}` : undefined);
  const detailsId = useId();
  const presentation = useMemo(
    () => toolCallPresentation(call, locale),
    [call.toolId, call.category, call.inputSummary, locale],
  );
  const Icon = presentation.icon;
  const hasDetails = Boolean(call.inputSummary || call.outputSummary);
  const failed = call.status === "failed" || call.status === "denied";
  // One record, one line: a folded call reports how it ended, an open call
  // reports its input. The full input/output stay in the details body.
  const summary = call.outputSummary
    ? (failed ? activityPreview : latestActivityPreview)(call.outputSummary, 180)
    : "";
  const detail = !expanded && summary
    ? (
        <span className="bui-tool-result" data-error={failed || undefined} title={summary}>
          {summary}
        </span>
      )
    : presentation.target
      ? <span className="bui-tool-target" title={presentation.target}>{presentation.target}</span>
      : null;
  const heading = (
    <>
      <span className="bui-tool-symbol">
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className="bui-tool-copy">
        <span className="bui-tool-label" title={presentation.name}>{presentation.name}</span>
        {detail}
      </span>
      <span className="bui-tool-meta">
        {call.duration && <span>{call.duration}</span>}
        {call.status === "running" && call.execution && call.execution.phase !== "waiting_model"
          ? <ExecutionProgressLabel progress={call.execution} />
          : <ActivityStatus status={call.status} />}
        {call.status !== "running" && (call.execution?.queueWaitMs ?? 0) >= 1000 &&
          <span>{locale === "zh" ? "排队" : "Queued"} {((call.execution?.queueWaitMs ?? 0) / 1000).toFixed(1)}s</span>}
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
        <HeadlessButton
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          className="bui-tool-trigger"
        >
          {heading}
        </HeadlessButton>
      ) : (
        <div className="bui-tool-trigger">{heading}</div>
      )}
      {expanded && hasDetails && (
        <div id={detailsId} className="bui-tool-details">
          <div className="bui-tool-detail-label">{presentation.name}</div>
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
});
