import { Check } from "lucide-react";
import type { CSSProperties, RefObject } from "react";
import { useLocale } from "../../shared/hooks/useLocale";
import { useSelectionAutoCopy } from "./useSelectionAutoCopy";
import "./selectionCopyPill.css";

/**
 * Confirmation for the copy that runs the moment a transcript selection ends.
 *
 * It lives in the transcript viewport (the only `relative` ancestor above the
 * scrolling body), rides the selection's last line and never accepts pointer
 * events, so a second drag can start right on top of it.
 */
export function SelectionCopyPill({
  hostRef,
  scopeRef,
  scrollRef,
}: {
  hostRef: RefObject<HTMLElement | null>;
  scopeRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const { locale } = useLocale();
  const pill = useSelectionAutoCopy({ hostRef, scopeRef, scrollRef });
  if (!pill) return null;

  return (
    <div
      className="selection-copy-pill"
      data-visible={pill.visible ? "true" : "false"}
      data-placement={pill.placement}
      style={
        {
          top: `${pill.top}px`,
          "--selection-copy-x": `${pill.left}px`,
        } as CSSProperties
      }
      role="status"
      aria-live="polite"
    >
      <Check size={13} strokeWidth={2.6} aria-hidden="true" />
      <span>{locale === "zh" ? "已复制到剪贴板" : "Copied to clipboard"}</span>
    </div>
  );
}
