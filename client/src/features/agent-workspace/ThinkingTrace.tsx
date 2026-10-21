import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { Button as HeadlessButton } from "@headlessui/react";
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
  const hasBody = Boolean(children);
  const expanded = hasBody && (manual ?? false);
  const bodyId = useId();

  const heading = (
    <>
      <span className="bui-thinking-symbol">{icon ?? <ThinkingGlyph />}</span>
      <span className="bui-thinking-copy">
        <span className="bui-thinking-label">{label}</span>
        {!expanded && preview && <span className="bui-thinking-preview">{preview}</span>}
      </span>
      {meta && <span className="bui-thinking-meta">{meta}</span>}
      {hasBody && (
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
      {hasBody ? (
        <HeadlessButton
          type="button"
          className="bui-thinking-trigger"
          aria-expanded={expanded}
          aria-controls={bodyId}
          title={expanded ? undefined : title}
          onClick={() => {
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
      {hasBody && (
        <div
          className="bui-thinking-reveal"
          id={bodyId}
          aria-hidden={!expanded}
          inert={!expanded}
        >
          <div className="bui-thinking-clip">
            {expanded && (
              <div className="bui-thinking-trace">
                <div
                  data-activity-body=""
                  className="bui-thinking-body session-work-log-body"
                  style={{ maxHeight }}
                >
                  {children}
                </div>
                {expanded && footer}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
