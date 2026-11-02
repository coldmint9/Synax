import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip } from "./Tooltip";

/** Supplemental help, available on hover, keyboard focus and touch. */
export function InfoTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip content={children} openOnClick>
      <button type="button" className="ui-info-tooltip" aria-label={label}>
        <Info size={14} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
