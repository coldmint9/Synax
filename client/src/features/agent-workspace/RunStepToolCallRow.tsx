import { useState } from "react";
import { useLocale } from "../../shared/hooks/useLocale";
import { toolCallPresentation } from "./toolCallPresentation";
import {
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import type { RuntimeEvent } from "../../adapters/transport/agentRuntime";

interface Props {
  event: RuntimeEvent;
}

export function RunStepToolCallRow({ event }: Props) {
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const payload = event.payload as Record<string, unknown>;
  const toolId = (payload.toolId as string) ?? "tool";
  const inputSummary = (payload.inputSummary as string) ?? "";
  const outputSummary = (payload.outputSummary as string) ?? "";
  const status = (payload.status as string) ?? "";
  const presentation = toolCallPresentation({ toolId, inputSummary, category: String(payload.category ?? payload.mutability ?? "") }, locale);
  const Icon = presentation.icon;

  return (
    <div className="group">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] hover:bg-secondary/40"
      >
        {expanded ? (
          <ChevronDown
            size={10}
            className="shrink-0 text-muted-foreground/60"
          />
        ) : (
          <ChevronRight
            size={10}
            className="shrink-0 text-muted-foreground/60"
          />
        )}
        <Icon size={11} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground/80" title={presentation.name}>
          {presentation.name}
        </span>
        {presentation.target && (
          <span className="truncate text-muted-foreground">{presentation.target}</span>
        )}
        {status === "failed" && (
          <span className="text-[10px] text-danger">failed</span>
        )}
      </button>

      {expanded && outputSummary && (
        <div className="ml-5 mt-0.5 rounded border border-border/50 bg-background/80 p-2">
          <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
            {outputSummary.length > 500
              ? outputSummary.slice(0, 500) + "\n..."
              : outputSummary}
          </pre>
        </div>
      )}
    </div>
  );
}
