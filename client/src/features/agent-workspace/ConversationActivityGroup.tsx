import { useCallback, useId, useMemo } from "react";
import { Button } from "@headlessui/react";
import { ChevronDown } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import type { TurnContentBlock } from "./buildInterleavedTurns";
import { activityPreview, thinkingBannerPhrase } from "./activityText";
import { conversationActivitySummary, conversationToolPresentation } from "./conversationActivity";
import { flattenToolBlocks } from "./toolCallUtils";
import { parseFileLink, type FileLinkTarget, type ToolFileLinks } from "./fileLink";
import { useTranscriptSession } from "./SessionTranscriptContext";
import { openWorkspaceFile } from "./state/sessionWorkspaceStore";
import { toolRoundRows } from "./ToolCallRoundPanel";
import { useActivityDisclosure } from "./useActivityDisclosure";
import { ActivityDisclosure } from "./ActivityDisclosure";
import { StreamingActivityLine } from "./StreamingActivityLine";
import { VirtualActivityWindow } from "./VirtualActivityWindow";

/**
 * Records own the file links their calls point at: the transcript scope answers
 * both "can this path be opened" and "open it", so a row never guesses.
 */
function useToolFileLinks(): ToolFileLinks | undefined {
  const { sessionId, workspacePath, roots } = useTranscriptSession();
  const resolve = useCallback(
    (raw: string) => parseFileLink(raw, undefined, workspacePath, roots),
    [workspacePath, roots],
  );
  const open = useCallback(
    (target: FileLinkTarget) => {
      if (!sessionId) return;
      openWorkspaceFile(sessionId, target.path, target.line, target.rootId, target.rootName);
    },
    [sessionId],
  );
  return useMemo(
    () => (sessionId ? { resolve, open } : undefined),
    [open, resolve, sessionId],
  );
}

function ActivityRows({ blocks, working, streaming, rememberKey, fileLinks }: {
  blocks: TurnContentBlock[];
  working: boolean;
  streaming: boolean;
  rememberKey?: string;
  fileLinks?: ToolFileLinks;
}) {
  const calls = flattenToolBlocks(blocks);
  const thought = [...blocks].reverse().find((block) => block.type === "thinking");
  const rows = toolRoundRows(blocks.filter((block) => !(working && block === thought && calls.length)), {
    isStreaming: streaming,
    rememberKey,
    individual: true,
    fileLinks,
  }).map((row) => ({
    key: row.key,
    node: <div className="session-flow-entry" data-process data-activity>{row.node}</div>,
  }));
  // Keep large historical call logs virtualized as well. Live rows still
  // follow the newest call, while settled logs get the same bounded viewport
  // when they exceed the visible budget instead of mounting every record.
  const visibleRows = 9;
  const windowed = working || rows.length > visibleRows;
  return <VirtualActivityWindow rows={rows} windowed={windowed} visibleRows={visibleRows} rowHeight={25} animate={streaming} />;
}

export function ConversationActivityGroup({ blocks, rememberKey, working, streaming, defaultExpanded }: {
  blocks: TurnContentBlock[];
  rememberKey?: string;
  working: boolean;
  streaming: boolean;
  defaultExpanded?: boolean;
}) {
  const { locale } = useLocale();
  const calls = flattenToolBlocks(blocks);
  const fileLinks = useToolFileLinks();
  const [expanded, toggle] = useActivityDisclosure(rememberKey ? `process:${rememberKey}` : undefined, defaultExpanded ?? (working && calls.length > 0));
  const id = useId();
  const summary = conversationActivitySummary(calls, locale);
  const thought = [...blocks].reverse().find((block) => block.type === "thinking");
  const thoughtText = thought?.type === "thinking"
    ? thinkingBannerPhrase(thought.content) ?? activityPreview(thought.content, 240)
    : null;
  const latestCall = calls[calls.length - 1];
  const latest = latestCall ? conversationToolPresentation(latestCall, locale) : null;
  const label = working
    ? thoughtText ?? (latest ? `${latest.label} ${latest.displayTarget}` : locale === "zh" ? "正在思考" : "Thinking")
    : summary.text || thoughtText || (locale === "zh" ? "思考过程" : "Thought process");
  const Icon = summary.icon;
  return (
    <section className="session-activity-group" data-live={working || undefined} data-expanded={expanded}>
      {/* The summary states what happened, never how it ended: outcomes stay on
          the individual call rows inside the disclosure. */}
      <Button type="button" className="session-process-trigger" onClick={toggle} aria-expanded={expanded} aria-controls={id} aria-label={working ? label : undefined}>
        {!working && calls.length > 0 && <Icon size={16} strokeWidth={1.7} className="session-process-symbol" aria-hidden="true" />}
        {working ? <StreamingActivityLine text={label} streaming={streaming} /> : <span className="session-process-summary">{label}</span>}
        <ChevronDown size={14} className="session-process-chevron" aria-hidden="true" />
      </Button>
      <ActivityDisclosure open={expanded} id={id} className="session-process-window">
        <ActivityRows blocks={blocks} working={working} streaming={streaming} rememberKey={rememberKey} fileLinks={fileLinks} />
      </ActivityDisclosure>
    </section>
  );
}
