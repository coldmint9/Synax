import { useEffect, useMemo } from "react";
import { ComposerEffortControl } from "./ComposerEffortControl";
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from "@/react/components/ui/Popover";
import { OverlayStateObserver } from "@/react/components/ui/OverlayStateObserver";
import type { ReasoningEffort } from "../../../../lib/api/agentRuntime";
import {
  ALL_REASONING_EFFORTS,
  parseReasoningEfforts,
} from "../../settings/lib/providerPresets";
import { useLocale } from "../../../../hooks/useLocale";
import "./composerEffortPicker.css";

export type ComposerReasoningEffort = ReasoningEffort;

const FALLBACK: ReasoningEffort = "high";

interface Props {
  effort: ReasoningEffort;
  allowed?: ReasoningEffort[];
  modelLabel?: string | null;
  onChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
  onOverlayOpenChange?: (open: boolean) => void;
}

export function ComposerEffortPicker(props: Props) {
  return (
    <Popover>
      {({ open, close }) => (
        <EffortPickerContent {...props} open={open} close={close} />
      )}
    </Popover>
  );
}

function EffortPickerContent({
  effort,
  allowed,
  onChange,
  disabled,
  onOverlayOpenChange,
  open,
  close,
}: Props & { open: boolean; close: () => void }) {
  const { t } = useLocale();
  useEffect(() => {
    if (disabled && open) close();
  }, [disabled, open, close]);
  const levels = useMemo<ReasoningEffort[]>(() => {
    const configured = parseReasoningEfforts(allowed);
    return configured.length > 0 ? configured : ALL_REASONING_EFFORTS;
  }, [allowed]);

  // Keep an existing selection valid when the selected provider's allowed set changes.
  useEffect(() => {
    if (!open || disabled) return;
    const current = effort;
    if (levels.includes(current)) return;
    const fallback = levels.includes(FALLBACK)
      ? FALLBACK
      : (levels[0] ?? FALLBACK);
    if (fallback !== current) onChange(fallback);
  }, [open, disabled, levels, effort, onChange]);

  const activeEffort = levels.includes(effort)
    ? effort
    : levels.includes(FALLBACK)
      ? FALLBACK
      : (levels[0] ?? FALLBACK);

  return (
    <>
      <OverlayStateObserver open={open} onOpenChange={onOverlayOpenChange} />
      <PopoverButton
        aria-label={t("effortLabel")}
        disabled={disabled}
        className={`agent-dock-composer-chip inline-flex h-7 max-w-[4.75rem] shrink-0 items-center rounded-full px-2.5 text-[11px] font-normal text-muted-foreground${
          disabled ? " pointer-events-none opacity-50" : ""
        }`}
      >
        {/* Raw level id (`low` … `max`) — the translated label is kept for
            assistive tech only. */}
        <span className="truncate font-medium tracking-tight text-foreground/85">
          {activeEffort}
        </span>
      </PopoverButton>
      <PopoverPanel
        focus
        anchor={{ to: "top end", gap: 8, padding: 8 }}
        className="composer-effort-picker z-50 w-[20rem] overflow-hidden p-0"
      >
        {open && (
          <div className="composer-effort-content">
            <ComposerEffortControl
              effort={activeEffort}
              levels={levels}
              label={t("effortLabel")}
              disabled={disabled}
              onChange={onChange}
            />
            <p className="composer-effort-hint">
              {allowed && allowed.length > 0
                ? t("effortAllowedHint")
                : t("effortUnrestrictedHint")}
            </p>
          </div>
        )}
      </PopoverPanel>
    </>
  );
}
