import { memo, useId, useMemo } from "react";
import { Bot, ChevronDown } from "lucide-react";
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
import { ToolCallMediaStrip } from "./ToolCallMediaStrip";
import {
  isSubagentMessageNotSent,
  toolCallDisplayStatus,
  type SubagentTarget,
} from "./toolCallPresentation";
import { useTranscriptSession } from "./SessionTranscriptContext";
import { openWorkspaceSubagent } from "./state/sessionWorkspaceStore";

interface Props {
  call: ToolCallView;
  rememberKey?: string;
  /** Session scope used to open a record's file target in the viewer. */
  fileLinks?: ToolFileLinks;
}

export function SubagentObjectButton({ target }: { target: SubagentTarget }) {
  const { locale } = useLocale();
  const { sessionId } = useTranscriptSession();
  const childSessionId = target.id;
  const label = locale === "zh"
    ? `打开${target.subject}会话`
    : `Open ${target.subject} conversation`;
  const content = (
    <>
      <Bot size={13} strokeWidth={2} aria-hidden="true" />
      <span>{target.subject}</span>
    </>
  );
  if (!sessionId || !childSessionId) {
    return <span className="bui-subagent-object" title={label}>{content}</span>;
  }
  return (
    <button
      type="button"
      className="bui-subagent-object"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        openWorkspaceSubagent(sessionId, childSessionId, target.subject);
      }}
    >
      {content}
    </button>
  );
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
  const status = toolCallDisplayStatus(call);
  const failed = status === "failed" || status === "denied";
  const notSent = isSubagentMessageNotSent(call);
  // Pending is in-flight work, not an outcome: the label already reads "正在…".
  const exceptional = !notSent && !["completed", "running", "pending"].includes(status);
  // A folded record states what the call asked for, never what it returned: the
  // runtime echo repeats the input ("bash (exit 0): <command>",
  // "Patched 1 file: <path>") and would push the file or command out of the
  // row, so every payload waits behind the disclosure. A failed or denied call
  // is the exception — transcript content the model must act on, never an
  // application error: the row states it inline and deliberately avoids the
  // error markers the toast bridge promotes.
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
      {expanded ? presentation.target : presentation.displayTarget}
    </span>
  );
  const subagentLabelParts = presentation.subagent
    ? (() => {
        const index = presentation.label.indexOf(presentation.subagent.subject);
        return index < 0
          ? null
          : {
              before: presentation.label.slice(0, index),
              after: presentation.label.slice(index + presentation.subagent.subject.length),
            };
      })()
    : null;
  const symbol = (
    <span className="bui-tool-symbol">
      <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
    </span>
  );
  const copy = notSent ? (
    <span className="bui-tool-copy">
      <span className="bui-tool-result" data-tool-blocked title={t("activitySubagentMessageNotSent")}>
        {t("activitySubagentMessageNotSent")}
      </span>
    </span>
  ) : (
    <span className="bui-tool-copy">
      <span className="bui-tool-label">{subagentLabelParts?.before ?? presentation.label}</span>
      {(presentation.additions > 0 || presentation.deletions > 0) && (
        <span className="bui-tool-diff">+{presentation.additions} -{presentation.deletions}</span>
      )}
      {/* With a link target, the path leaves the disclosure button so the two
          actions stay separate elements instead of nesting controls. */}
      {!fileTarget && target}
      {failure && (
        <span className="bui-tool-result" data-tool-failure title={failure}>
          {failure}
        </span>
      )}
    </span>
  );
  const meta =
    exceptional || expandable || call.execution?.phase === "queued_resources" || call.execution?.phase === "cancelling" ? (
      <span className="bui-tool-meta">
        {call.status === "running" && call.execution && call.execution.phase !== "waiting_model"
          ? <ExecutionProgressLabel progress={call.execution} />
          : exceptional ? <ActivityStatus status={status} /> : null}
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
  // Reads and generated media carry their images on the record itself. They
  // stay visible on the collapsed row, so a picture never hides behind the
  // text payload disclosure.
  const media = <ToolCallMediaStrip calls={[call]} />;

  if (fileTarget) {
    return (
      <div className="bui-tool" data-tool-status={status} data-expanded={expanded}>
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
        {media}
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
  const subagentHeading = subagentLabelParts && presentation.subagent ? (
    <div className="bui-tool-trigger bui-tool-trigger--subagent">
      {expandable ? (
        <HeadlessButton
          type="button"
          onClick={reveal}
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={notSent ? t("activitySubagentMessageNotSent") : presentation.label}
          className="bui-tool-disclosure"
        >
          {symbol}
          {copy}
          {!notSent && <span className="bui-tool-label">{subagentLabelParts.after}</span>}
          {meta}
        </HeadlessButton>
      ) : (
        <div className="bui-tool-disclosure">
          {symbol}
          {copy}
          {!notSent && <span className="bui-tool-label">{subagentLabelParts.after}</span>}
          {meta}
        </div>
      )}
      <SubagentObjectButton target={presentation.subagent} />
    </div>
  ) : null;
  return (
    <div className="bui-tool" data-tool-status={status} data-expanded={expanded}>
      {subagentHeading ?? (expandable ? (
        <HeadlessButton type="button" onClick={reveal} aria-expanded={expanded} aria-controls={detailsId} className="bui-tool-trigger">
          {heading}
        </HeadlessButton>
      ) : <div className="bui-tool-trigger">{heading}</div>)}
      {media}
      {details}
    </div>
  );
});
