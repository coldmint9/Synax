import { useEffect, useMemo, useRef } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import { Popover, useOverlayState } from "@heroui/react";
import type { ReasoningEffort } from "../../../../lib/api/agentRuntime";
import { REASONING_EFFORT_LABELS } from "../../settings/lib/providerPresets";
import { useLocale } from "../../../../hooks/useLocale";
import "./composerEffortPicker.css";

export type ComposerReasoningEffort = ReasoningEffort;

const FALLBACK: ReasoningEffort = "high";
const ALL_LEVELS: ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

interface Props {
  effort: ReasoningEffort;
  allowed?: ReasoningEffort[];
  modelLabel?: string | null;
  onChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
  onOverlayOpenChange?: (open: boolean) => void;
}

export function ComposerEffortPicker({
  effort,
  allowed,
  modelLabel,
  onChange,
  disabled,
  onOverlayOpenChange,
}: Props) {
  const { t } = useLocale();
  const state = useOverlayState({ onOpenChange: onOverlayOpenChange });
  const lastEffortRef = useRef(effort);

  const levels = useMemo<ReasoningEffort[]>(
    () => (allowed && allowed.length > 0 ? allowed : ALL_LEVELS),
    [allowed],
  );

  // Keep an existing selection valid when the selected provider's allowed set changes.
  useEffect(() => {
    if (!state.isOpen) return;
    const current = lastEffortRef.current;
    if (levels.includes(current)) return;
    const fallback = levels.includes(FALLBACK)
      ? FALLBACK
      : (levels[0] ?? FALLBACK);
    if (fallback !== current) onChange(fallback);
  }, [state.isOpen, levels, onChange]);

  useEffect(() => {
    lastEffortRef.current = effort;
  }, [effort]);

  const activeEffort = levels.includes(effort)
    ? effort
    : levels.includes(FALLBACK)
      ? FALLBACK
      : (levels[0] ?? FALLBACK);
  const idx = Math.max(0, levels.indexOf(activeEffort));
  const count = Math.max(1, levels.length);
  // The thumb is 1.75rem wide inside the rail's 0.25rem padding, so its travel
  // range is inset by half the thumb at both ends. Station dots share the exact
  // same centre, keeping the thumb and groove visually nested at either end.
  const stationFraction = (index: number) =>
    count <= 1 ? 0.5 : index / (count - 1);
  const stationLeft = (index: number) =>
    `calc(1.125rem + (100% - 2.25rem) * ${stationFraction(index)})`;
  const thumbLeft = stationLeft(idx);
  const fillWidth = `calc(0.875rem + (100% - 2.25rem) * ${stationFraction(idx)})`;
  const modelText = modelLabel?.trim() || t("effortCurrentModel");

  function resetEffort() {
    const next = levels.includes(FALLBACK) ? FALLBACK : (levels[0] ?? FALLBACK);
    if (next !== effort) onChange(next);
  }

  return (
    <Popover
      isOpen={disabled ? false : state.isOpen}
      onOpenChange={(open) => {
        if (disabled) return;
        state.setOpen(open);
      }}
    >
      <Popover.Trigger
        aria-label={t("effortLabel")}
        aria-disabled={Boolean(disabled)}
        className={`agent-dock-composer-chip inline-flex h-7 max-w-[4.75rem] shrink-0 items-center rounded-full px-2.5 text-[11px] font-normal text-muted-foreground${
          disabled ? " pointer-events-none opacity-50" : ""
        }`}
      >
        {/* Raw level id (`low` … `max`) — the translated label is kept for
            assistive tech only. */}
        <span className="truncate font-medium tracking-tight text-foreground/85">
          {activeEffort}
        </span>
      </Popover.Trigger>
      <Popover.Content
        placement="top end"
        offset={8}
        className="composer-effort-picker z-50 w-[16rem] overflow-hidden rounded-xl p-0"
      >
        <div className="px-3 pb-3 pt-2.5">
          {/* Compact header: current effort, disclosure chevron, reset affordance. */}
          <div className="relative flex min-h-6 items-center justify-center">
            <div className="flex items-center gap-0.5">
              <span className="composer-effort-value text-sm font-medium leading-none">
                {activeEffort}
              </span>
              <ChevronRight size={12} className="text-muted-foreground/75" />
            </div>
            <button
              type="button"
              aria-label={t("effortResetAria")}
              title={t("effortReset")}
              onClick={resetEffort}
              className="absolute right-0 inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <RotateCcw size={12} />
            </button>
          </div>
          <div
            className="mt-1 truncate text-center text-[10px] leading-4 text-muted-foreground"
            title={modelText}
          >
            {modelText}
          </div>

          {/* Compact slider: semantic accent fill, surface thumb, and station dots. */}
          <div
            role="radiogroup"
            aria-label={t("effortLabel")}
            className="composer-effort-rail relative mt-2.5 flex h-8 items-center rounded-full p-1"
          >
            <span
              aria-hidden
              className="composer-effort-fill pointer-events-none absolute left-1 top-1 bottom-1 rounded-full transition-[width] duration-300"
              style={{
                width: fillWidth,
                transitionTimingFunction: "cubic-bezier(0.34, 0.9, 0.4, 1)",
              }}
            />
            <span
              aria-hidden
              className="composer-effort-thumb pointer-events-none absolute top-1/2 z-20 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[left] duration-300"
              style={{
                left: thumbLeft,
                transitionTimingFunction: "cubic-bezier(0.34, 0.9, 0.4, 1)",
              }}
            />
            {levels.map((level, index) => {
              const selected = level === activeEffort;
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={REASONING_EFFORT_LABELS[level]}
                  onClick={() => {
                    // Keep the card open after changing intensity, like Codex.
                    if (!selected) onChange(level);
                  }}
                  style={{ left: stationLeft(index) }}
                  className="composer-effort-station group/effort-station absolute top-1/2 z-30 grid size-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full outline-none transition-colors duration-200"
                >
                  <span
                    aria-hidden
                    className="composer-effort-dot size-1.5 rounded-full transition-[background-color,transform] duration-200 group-hover/effort-station:scale-150"
                  />
                </button>
              );
            })}
          </div>

          <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
            {allowed && allowed.length > 0
              ? t("effortAllowedHint")
              : t("effortUnrestrictedHint")}
          </p>
        </div>
      </Popover.Content>
    </Popover>
  );
}
