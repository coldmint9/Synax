import { WebSearchResults } from "./WebSearchResults";
import { useLocale } from "../../shared/hooks/useLocale";
import { toolCallPresentation } from "./toolCallPresentation";
import { MediaParts } from "../media/MediaParts";
import { useState } from "react";
import { MarkdownRenderer } from "../../shared/ui/markdown/MarkdownRenderer";
import { Card, Badge } from "@/shared/ui/ui/Display";
import {
  ChevronRight,
  ChevronDown,
  Clock,
} from "lucide-react";
import type { ToolCallView } from "./buildInterleavedTurns";

interface Props {
  call: ToolCallView;
}

const STATUS_COLOR: Record<
  string,
  "accent" | "success" | "danger" | "warning" | "default"
> = {
  running: "accent",
  completed: "success",
  failed: "danger",
  denied: "warning",
  cancelled: "default",
  compacted: "default",
};

export function EnhancedToolCallCard({ call }: Props) {
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const presentation = toolCallPresentation(call, locale);
  const Icon = presentation.icon;
  const inputLabel = presentation.target;
  const hasOutput = Boolean(call.outputSummary);
  const outputText = call.outputSummary ?? "";
  const isLong = outputText.length > 800;
  const chipColor = STATUS_COLOR[call.status] ?? "default";
  const designPreviewContent =
    call.toolId === "design.preview" &&
    call.outputRef &&
    typeof call.outputRef === "object" &&
    "content" in call.outputRef &&
    typeof call.outputRef.content === "string"
      ? call.outputRef.content
      : null;

  return (
    <Card
      className={`shadow-none transition-colors animate-[fade-up_0.3s_ease-out] ${
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
        {inputLabel && (
          <span className="truncate text-xs text-muted-foreground">
            {inputLabel}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {call.duration && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/60">
              <Clock size={9} />
              {call.duration}
            </span>
          )}
          <Badge
            size="sm"
            tone={chipColor}
            variant="soft"
            className="h-4 text-[9px]"
          >
            {call.status}
          </Badge>
          {hasOutput &&
            (expanded ? (
              <ChevronDown size={12} className="text-muted-foreground" />
            ) : (
              <ChevronRight size={12} className="text-muted-foreground" />
            ))}
        </span>
      </button>

      <MediaParts parts={call.contentParts} />
      {expanded && call.outputSummary && (
        <div className="bui-tool-card-output border-t border-border/40 px-3 pb-2.5 pt-2">
          {designPreviewContent ? (
            <MarkdownRenderer
              content={designPreviewContent}
              className="feed-prose text-sm"
            />
          ) : (
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
              {showFull || !isLong
                ? outputText
                : outputText.slice(0, 800) + "\n..."}
            </pre>
          )}
          {call.toolId === "webSearch" && (
            <WebSearchResults output={call.outputRef} />
          )}
          {isLong && !showFull && (
            <button
              type="button"
              onClick={() => setShowFull(true)}
              className="mt-1 text-[10px] text-primary/70 hover:text-primary"
            >
              查看全部 ({Math.ceil(outputText.length / 1000)}k chars)
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
