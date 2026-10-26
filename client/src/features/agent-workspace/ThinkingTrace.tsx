import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { Button as HeadlessButton } from "@headlessui/react";
import { ActivityDisclosure } from "./ActivityDisclosure";
import {
  useActivityRowActive,
  useActivityRowExpansion,
  useCompactActivityRow,
} from "./ActivityRowScope";
import "./conversationFlow.css";

// Transcript virtualization unmounts rows. Keep explicit reader choices across remounts.
const expandedTraces = new Map<string, boolean>();

export function ThinkingGlyph() {
  return <Sparkles size={16} aria-hidden="true" />;
}

interface Props {
  label: string;
  working?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  rememberKey?: string;
  title?: string;
  meta?: string | null;
  preview?: string;
  maxHeight?: string | number;
  variant?: "reasoning" | "steps" | "coding" | "search";
}

/** A real-event-driven ThinkingState: animation never decides whether work is done. */
export function ThinkingTrace({
  label,
  working = false,
  icon,
  children,
  footer,
  rememberKey,
  title,
  meta,
  preview,
  maxHeight = 240,
  variant = "reasoning",
}: Props) {
  const [manual, setManual] = useState<boolean | null>(() =>
    rememberKey ? (expandedTraces.get(rememberKey) ?? null) : null,
  );
  useEffect(() => {
    setManual(rememberKey ? (expandedTraces.get(rememberKey) ?? null) : null);
  }, [rememberKey]);
  // Inside the live window a thought is one row while the window follows the
  // newest record. Opening it expands this row only, so the body can take its
  // natural height without laying out every other record.
  const compact = useCompactActivityRow();
  const active = useActivityRowActive();
  const expandRow = useActivityRowExpansion();
  const hasBody = Boolean(children);
  const expandable = hasBody;
  const expanded = expandable && (manual ?? false) && (!compact || active);
  const bodyId = useId();

  const heading = (
    <>
      <span className="bui-thinking-symbol">{icon ?? <ThinkingGlyph />}</span>
      <span className="bui-thinking-copy">
        <span className="bui-thinking-label">{label}</span>
        {!expanded && preview && <span className="bui-thinking-preview">{preview}</span>}
      </span>
      {meta && <span className="bui-thinking-meta">{meta}</span>}
      {expandable && (
        <ChevronRight
          size={14}
          className="bui-thinking-chevron"
          aria-hidden="true"
        />
      )}
    </>
  );

  return (
    <div
      className="bui-thinking"
      data-live={working || undefined}
      data-expanded={expanded}
      data-variant={variant}
    >
      {expandable ? (
        <HeadlessButton
          type="button"
          className="bui-thinking-trigger"
          aria-expanded={expanded}
          aria-controls={bodyId}
          title={expanded ? undefined : title}
          onClick={() => {
            // Claiming the window's single open slot must open this thought,
            // even when it was opened before and its neighbour took the slot.
            if (compact && !active) {
              expandRow?.();
              setManual(true);
              if (rememberKey) expandedTraces.set(rememberKey, true);
              return;
            }
            const next = !expanded;
            setManual(next);
            if (rememberKey) expandedTraces.set(rememberKey, next);
          }}
        >
          {heading}
        </HeadlessButton>
      ) : (
        <div className="bui-thinking-trigger" title={title}>
          {heading}
        </div>
      )}
      {expandable && (
        <ActivityDisclosure open={expanded} id={bodyId} className="bui-thinking-reveal">
          <div className="bui-thinking-trace">
            <div data-activity-body="" className="bui-thinking-body session-work-log-body" style={{ maxHeight }}>
              {children}
            </div>
            {footer}
          </div>
        </ActivityDisclosure>
      )}
    </div>
  );
}
