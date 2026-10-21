import { useId, useMemo } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { Button as HeadlessButton } from "@headlessui/react";
import { useLocale } from "../../shared/hooks/useLocale";
import { ActivityStatus } from "../../shared/ui/beautiful-ui/ActivityStatus";
import { ToolCallSummaryLine } from "./ToolCallSummaryLine";
import {
  aggregateToolStatus,
  toolCallPresentation,
} from "./toolCallPresentation";
import type { ToolCallBatch } from "./toolCallUtils";
import { activityPreview } from "./activityText";
import { useActivityDisclosure } from "./useActivityDisclosure";
import { ActivityDisclosure } from "./ActivityDisclosure";
import { useCompactActivityRow } from "./ActivityRowScope";

interface Props {
  batch: ToolCallBatch;
  rememberKey?: string;
}

export function ToolCallBatchSummaryLine({ batch, rememberKey }: Props) {
  const { locale } = useLocale();
  const [open, toggle] = useActivityDisclosure(rememberKey ? `${rememberKey}:batch:${batch.calls[0]?.id}` : undefined);
  // Inside the live window a batch is one row: the window follows the newest
  // record, so the per-call breakdown stays closed until the turn settles.
  const compact = useCompactActivityRow();
  const expanded = open && !compact;
  const detailsId = useId();
  const { calls } = batch;
  const presentation = useMemo(() => toolCallPresentation(calls[0], locale), [calls, locale]);
  const Icon = presentation.icon;
  const status = aggregateToolStatus(calls);
  const targets = useMemo(() => [...new Set(calls.map((call) => toolCallPresentation(call, locale).target).filter(Boolean))].join(" · "), [calls, locale]);
  const failed = calls.find((call) => call.status === "failed" || call.status === "denied");
  const failurePreview = failed?.outputSummary ? activityPreview(failed.outputSummary, 180) : "";

  if (calls.length === 1) return <ToolCallSummaryLine call={calls[0]} rememberKey={rememberKey} />;

  const heading = (
    <>
      <span className="bui-tool-symbol">
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className="bui-tool-copy">
        <span className="bui-tool-label" title={presentation.name}>{presentation.name}</span>
        {!expanded && failurePreview ? (
          <span className="bui-tool-result" data-error="true" title={failurePreview}>{failurePreview}</span>
        ) : targets ? (
          <span className="bui-tool-target" title={targets}>{targets}</span>
        ) : null}
      </span>
      <span className="bui-tool-meta">
        <span className="bui-tool-count">{locale === "zh" ? `${calls.length} 次调用` : `${calls.length} calls`}</span>
        <ActivityStatus status={status} />
        {!compact &&
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
    <div className="bui-tool" data-tool-status={status}>
      {compact ? (
        <div className="bui-tool-trigger">{heading}</div>
      ) : (
        <HeadlessButton
          type="button"
          onClick={toggle}
          className="bui-tool-trigger"
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
        >
          {heading}
        </HeadlessButton>
      )}
      <ActivityDisclosure open={expanded} id={detailsId}>
        <div className="bui-tool-batch-body">
          {calls.map((call) => (
            <ToolCallSummaryLine key={call.id} call={call} rememberKey={rememberKey} />
          ))}
        </div>
      </ActivityDisclosure>
    </div>
  );
}
