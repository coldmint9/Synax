import { memo, useId, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { Button as HeadlessButton } from "@headlessui/react";
import { useLocale } from "../../shared/hooks/useLocale";
import { ActivityStatus } from "../../shared/ui/beautiful-ui/ActivityStatus";
import type { ToolCallView } from "./buildInterleavedTurns";
import { conversationToolPresentation } from "./conversationActivity";
import type { ToolFileLinks } from "./fileLink";
import { activityPreview } from "./activityText";
import { useActivityDisclosure } from "./useActivityDisclosure";
import { ExecutionProgressLabel } from "./ExecutionProgressLabel";
import {
  useActivityRowActive,
  useActivityRowExpansion,
  useCompactActivityRow,
} from "./ActivityRowScope";
import { ActivityDisclosure } from "./ActivityDisclosure";

interface Props {
  call: ToolCallView;
  rememberKey?: string;
  /** Session scope used to open a record's file target in the viewer. */
  fileLinks?: ToolFileLinks;
}

export const ToolCallSummaryLine = memo(function ToolCallSummaryLine({
  call,
  rememberKey,
  fileLinks,
}: Props) {
  const { t, locale } = useLocale();
  const [open, toggle, setOpen] = useActivityDisclosure(rememberKey ? `${rememberKey}:tool:${call.id}` : undefined);
  const detailsId = useId();
  const presentation = useMemo(() => conversationToolPresentation(call, locale), [call, locale]);
  const Icon = presentation.icon;
  const hasDetails = Boolean(call.inputSummary || call.outputSummary);
  // A live window keeps one line per record. Opening a record expands only
  // this row, so the window stays virtualized for every other record.
  const compact = useCompactActivityRow();
  const active = useActivityRowActive();
  const expandRow = useActivityRowExpansion();
  const expandable = hasDetails;
  const expanded = expandable && open && (!compact || active);
  const reveal = () => {
    // Inside the live window only one record is open at a time. Claiming that
    // slot must show this record, not toggle a body that is already open.
    if (compact && !active) {
      expandRow?.();
      if (!open) setOpen(true);
      return;
    }
    toggle();
  };
  const failed = call.status === "failed" || call.status === "denied";
  // Pending is in-flight work, not an outcome: the label already reads "正在…".
  const exceptional = !["completed", "running", "pending"].includes(call.status);
  const failure = failed ? activityPreview(call.outputSummary, 180) : "";
  // The viewer can only open one file, so a multi-file patch or a glob keeps
  // reading as plain text instead of promising a link it cannot honour.
  const fileTarget =
    presentation.filePath && fileLinks
      ? fileLinks.resolve(presentation.filePath)
      : null;
  const target = fileTarget ? (
    <button
      type="button"
      className="bui-tool-target"
      data-file="true"
      title={presentation.target}
      onClick={() => fileLinks?.open(fileTarget)}
    >
      {presentation.displayTarget}
    </button>
  ) : (
    <span className="bui-tool-target" title={presentation.target}>
      {presentation.displayTarget}
    </span>
  );
  const symbol = (
    <span className="bui-tool-symbol">
      <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
    </span>
  );
  const copy = (
    <span className="bui-tool-copy">
      <span className="bui-tool-label">{presentation.label}</span>
      {/* With a link target, the path leaves the disclosure button so the two
          actions stay separate elements instead of nesting controls. */}
      {!fileTarget && target}
      {(presentation.additions > 0 || presentation.deletions > 0) && (
        <span className="bui-tool-diff">+{presentation.additions} -{presentation.deletions}</span>
      )}
      {failure && <span className="bui-tool-result" data-error title={failure}>{failure}</span>}
    </span>
  );
  const meta =
    exceptional || expandable || call.execution?.phase === "queued_resources" || call.execution?.phase === "cancelling" ? (
      <span className="bui-tool-meta">
        {call.status === "running" && call.execution && call.execution.phase !== "waiting_model"
          ? <ExecutionProgressLabel progress={call.execution} />
          : exceptional ? <ActivityStatus status={call.status} /> : null}
        {expandable && <ChevronDown size={12} className="bui-chevron" aria-hidden="true" />}
      </span>
    ) : null;
  const details = (
    <ActivityDisclosure open={expanded} id={detailsId}>
      <div className="bui-tool-details">
        {call.inputSummary && <div><div className="bui-tool-detail-label">{t("activityToolInput")}</div><pre>{call.inputSummary}</pre></div>}
        {call.outputSummary && <div><div className="bui-tool-detail-label">{t("activityToolOutput")}</div><pre>{call.outputSummary}</pre></div>}
      </div>
    </ActivityDisclosure>
  );

  if (fileTarget) {
    return (
      <div className="bui-tool" data-tool-status={call.status} data-expanded={expanded}>
        <div className="bui-tool-trigger bui-tool-trigger--split">
          {expandable ? (
            <HeadlessButton
              type="button"
              onClick={reveal}
              aria-expanded={expanded}
              aria-controls={detailsId}
              className="bui-tool-disclosure"
            >
              {symbol}
              {copy}
            </HeadlessButton>
          ) : (
            <div className="bui-tool-disclosure">
              {symbol}
              {copy}
            </div>
          )}
          {target}
          {meta}
        </div>
        {details}
      </div>
    );
  }

  const heading = (
    <>
      {symbol}
      {copy}
      {meta}
    </>
  );
  return (
    <div className="bui-tool" data-tool-status={call.status} data-expanded={expanded}>
      {expandable ? (
        <HeadlessButton type="button" onClick={reveal} aria-expanded={expanded} aria-controls={detailsId} className="bui-tool-trigger">
          {heading}
        </HeadlessButton>
      ) : <div className="bui-tool-trigger">{heading}</div>}
      {details}
    </div>
  );
});
