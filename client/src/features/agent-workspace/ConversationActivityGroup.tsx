import { useId } from "react";
import { Button } from "@headlessui/react";
import { ChevronDown } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { ActivityStatus } from "../../shared/ui/beautiful-ui/ActivityStatus";
import type { TurnContentBlock } from "./buildInterleavedTurns";
import { activityPreview, thinkingBannerPhrase } from "./activityText";
import { conversationActivitySummary, conversationToolPresentation } from "./conversationActivity";
import { flattenToolBlocks } from "./toolCallUtils";
import { aggregateToolStatus } from "./toolCallPresentation";
import { toolRoundRows } from "./ToolCallRoundPanel";
import { useActivityDisclosure } from "./useActivityDisclosure";
import { ActivityDisclosure } from "./ActivityDisclosure";
import { StreamingActivityLine } from "./StreamingActivityLine";
import { VirtualActivityWindow } from "./VirtualActivityWindow";

function ActivityRows({ blocks, working, streaming, rememberKey }: {
  blocks: TurnContentBlock[];
  working: boolean;
  streaming: boolean;
  rememberKey?: string;
}) {
  const calls = flattenToolBlocks(blocks);
  const thought = [...blocks].reverse().find((block) => block.type === "thinking");
  const rows = toolRoundRows(blocks.filter((block) => !(working && block === thought && calls.length)), {
    isStreaming: streaming,
    rememberKey,
    individual: true,
  }).map((row) => ({
    key: row.key,
    node: <div className="session-flow-entry" data-process data-activity>{row.node}</div>,
  }));
  return <VirtualActivityWindow rows={rows} windowed={working} visibleRows={9} rowHeight={25} animate={streaming} />;
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
  const status = aggregateToolStatus(calls);
  const exceptional = !["completed", "running"].includes(status);
  const Icon = summary.icon;
  return (
    <section className="session-activity-group" data-live={working || undefined} data-expanded={expanded}>
      <Button type="button" className="session-process-trigger" onClick={toggle} aria-expanded={expanded} aria-controls={id} aria-label={working ? `${label}${exceptional ? ` · ${status}` : ""}` : undefined}>
        {!working && calls.length > 0 && <Icon size={16} strokeWidth={1.7} className="session-process-symbol" aria-hidden="true" />}
        {working ? <StreamingActivityLine text={label} streaming={streaming} /> : <span className="session-process-summary">{label}</span>}
        <ChevronDown size={14} className="session-process-chevron" aria-hidden="true" />
        {exceptional && <span className="session-process-status"><ActivityStatus status={status} /></span>}
      </Button>
      <ActivityDisclosure open={expanded} id={id} className="session-process-window">
        <ActivityRows blocks={blocks} working={working} streaming={streaming} rememberKey={rememberKey} />
      </ActivityDisclosure>
    </section>
  );
}
