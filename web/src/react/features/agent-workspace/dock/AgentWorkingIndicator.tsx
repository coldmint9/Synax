import { useEffect, useState } from "react";
import type { DockSessionStatus } from "./dockSessionStream";

const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

const STATIC_GLYPH: Partial<Record<DockSessionStatus, string>> = {
  completed: "✓",
  failed: "×",
  idle: "·",
};

const STATUS_CLASS: Record<DockSessionStatus, string> = {
  running: "text-primary",
  waiting_permission: "text-warning",
  completed: "text-success",
  failed: "text-destructive",
  idle: "text-muted-foreground/35",
};

function isActive(status: DockSessionStatus): boolean {
  return status === "running" || status === "waiting_permission";
}

interface Props {
  status: DockSessionStatus;
  className?: string;
}

export function AgentWorkingIndicator({ status, className = "" }: Props) {
  const [frame, setFrame] = useState(0);
  const active = isActive(status);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setFrame((i) => (i + 1) % SPINNER_FRAMES.length);
    }, 120);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active) setFrame(0);
  }, [active]);

  const glyph = active ? SPINNER_FRAMES[frame] : (STATIC_GLYPH[status] ?? "·");

  return (
    <span
      className={`inline-flex w-[1ch] shrink-0 items-center justify-center font-mono text-[11px] leading-none tabular-nums ${STATUS_CLASS[status]} ${className}`}
      aria-hidden
    >
      {glyph}
    </span>
  );
}
