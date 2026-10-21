import { memo, useId, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { Button as HeadlessButton } from "@headlessui/react";
import { useLocale } from "../../shared/hooks/useLocale";
import { ActivityStatus } from "../../shared/ui/beautiful-ui/ActivityStatus";
import type { ToolCallView } from "./buildInterleavedTurns";
import { conversationToolPresentation } from "./conversationActivity";
import { activityPreview } from "./activityText";
import { useActivityDisclosure } from "./useActivityDisclosure";
import { ExecutionProgressLabel } from "./ExecutionProgressLabel";
import { useCompactActivityRow } from "./ActivityRowScope";
import { ActivityDisclosure } from "./ActivityDisclosure";

interface Props {
  call: ToolCallView;
  rememberKey?: string;
}

export const ToolCallSummaryLine = memo(function ToolCallSummaryLine({ call, rememberKey }: Props) {
  const { t, locale } = useLocale();
  const [open, toggle] = useActivityDisclosure(rememberKey ? `${rememberKey}:tool:${call.id}` : undefined);
  const detailsId = useId();
  const presentation = useMemo(() => conversationToolPresentation(call, locale), [call, locale]);
  const Icon = presentation.icon;
  const hasDetails = Boolean(call.inputSummary || call.outputSummary);
  const compact = useCompactActivityRow();
  const expandable = hasDetails && !compact;
  const expanded = expandable && open;
  const failed = call.status === "failed" || call.status === "denied";
  const exceptional = !["completed", "running"].includes(call.status);
  const failure = failed ? activityPreview(call.outputSummary, 180) : "";
  const heading = (
    <>
      <span className="bui-tool-symbol"><Icon size={16} strokeWidth={1.7} aria-hidden="true" /></span>
      <span className="bui-tool-copy">
        <span className="bui-tool-label">{presentation.label}</span>
        <span className="bui-tool-target" data-file={presentation.file || undefined} title={presentation.target}>
          {presentation.displayTarget}
        </span>
        {(presentation.additions > 0 || presentation.deletions > 0) && (
          <span className="bui-tool-diff">+{presentation.additions} -{presentation.deletions}</span>
        )}
        {failure && <span className="bui-tool-result" data-error title={failure}>{failure}</span>}
      </span>
      {(exceptional || expandable || call.execution?.phase === "queued_resources" || call.execution?.phase === "cancelling") && (
        <span className="bui-tool-meta">
          {call.status === "running" && call.execution && call.execution.phase !== "waiting_model"
            ? <ExecutionProgressLabel progress={call.execution} />
            : exceptional ? <ActivityStatus status={call.status} /> : null}
          {expandable && <ChevronDown size={12} className="bui-chevron" aria-hidden="true" />}
        </span>
      )}
    </>
  );

  return (
    <div className="bui-tool" data-tool-status={call.status} data-expanded={expanded}>
      {expandable ? (
        <HeadlessButton type="button" onClick={toggle} aria-expanded={expanded} aria-controls={detailsId} className="bui-tool-trigger">
          {heading}
        </HeadlessButton>
      ) : <div className="bui-tool-trigger">{heading}</div>}
      <ActivityDisclosure open={expanded} id={detailsId}>
        <div className="bui-tool-details">
          {call.inputSummary && <div><div className="bui-tool-detail-label">{t("activityToolInput")}</div><pre>{call.inputSummary}</pre></div>}
          {call.outputSummary && <div><div className="bui-tool-detail-label">{t("activityToolOutput")}</div><pre>{call.outputSummary}</pre></div>}
        </div>
      </ActivityDisclosure>
    </div>
  );
});
