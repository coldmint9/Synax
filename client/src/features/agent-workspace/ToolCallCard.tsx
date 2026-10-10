import { useState } from "react";
import { useLocale } from "../../shared/hooks/useLocale";
import { toolCallPresentation } from "./toolCallPresentation";
import {
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import type { ToolCallView } from "./buildConversationTurns";

interface Props {
  call: ToolCallView;
}

export function ToolCallCard({ call }: Props) {
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const presentation = toolCallPresentation(call, locale);
  const Icon = presentation.icon;
  const hasOutput = Boolean(call.outputSummary);

  return (
    <div
      className={`rounded-lg border transition-colors ${
        expanded
          ? "border-accent/20 bg-accent/5"
          : "border-border/60 bg-background/40"
      }`}
    >
      <button
        type="button"
        onClick={() => hasOutput && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon size={13} className="shrink-0 text-primary" />
        <span className="min-w-0 truncate text-xs font-semibold text-foreground" title={presentation.name}>
          {presentation.name}
        </span>
        {presentation.target && (
          <span className="truncate text-xs text-muted-foreground">
            {presentation.target}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {call.status === "failed" && (
            <span className="text-[10px] font-medium text-destructive">
              failed
            </span>
          )}
          {call.status === "running" && (
            <span className="text-[10px] font-medium text-[var(--color-agent)]">
              running
            </span>
          )}
          {hasOutput &&
            (expanded ? (
              <ChevronDown size={12} className="text-muted-foreground" />
            ) : (
              <ChevronRight size={12} className="text-muted-foreground" />
            ))}
        </span>
      </button>

      {expanded && call.outputSummary && (
        <div className="border-t border-border/40 px-3 pb-2.5 pt-2">
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
            {call.outputSummary.length > 800
              ? call.outputSummary.slice(0, 800) + "\n..."
              : call.outputSummary}
          </pre>
        </div>
      )}
    </div>
  );
}
