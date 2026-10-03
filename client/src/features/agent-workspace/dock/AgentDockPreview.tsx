import { ChevronUp } from "lucide-react";
import { AgentWorkingIndicator } from "./AgentWorkingIndicator";
import type { DockSessionStatus } from "./dockSessionStream";
import type { DockToolCall } from "./dockSessionStream";

interface Props {
  status: DockSessionStatus;
  latestTool: DockToolCall | undefined;
  thinkingPreview: string;
  sessionTitle: string;
  onClick: () => void;
}

function previewText(
  sessionTitle: string,
  latestTool: DockToolCall | undefined,
  thinkingPreview: string,
): string {
  if (latestTool) {
    const suffix = latestTool.outputSummary ?? latestTool.summary;
    return `${latestTool.tool} · ${suffix}`;
  }
  const trimmedThinking = thinkingPreview.trim();
  if (trimmedThinking) return trimmedThinking.slice(-80);
  return sessionTitle.trim();
}

export function AgentDockPreview({
  status,
  latestTool,
  thinkingPreview,
  sessionTitle,
  onClick,
}: Props) {
  const isRunning = status === "running";
  const text = previewText(sessionTitle, latestTool, thinkingPreview);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={sessionTitle}
      className={`agent-dock-preview-pill mb-1.5 flex w-[min(100%,20rem)] self-center items-center gap-2 rounded-full px-3 py-1.5 text-left text-[11px] transition-transform duration-150 active:scale-[0.98] ${
        isRunning
          ? "text-foreground"
          : status === "failed"
            ? "agent-dock-preview-pill--failed text-destructive"
            : "text-muted-foreground"
      }`}
    >
      <AgentWorkingIndicator status={status} />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <ChevronUp size={11} className="shrink-0 opacity-45" />
    </button>
  );
}
