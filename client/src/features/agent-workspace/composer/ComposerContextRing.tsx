import { Portal } from "@headlessui/react";
import {
  autoUpdate,
  flip,
  offset,
  safePolygon,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { useState } from "react";
import type { ContextUsageSnapshot } from "../../../adapters/transport/agentRuntime";
import { formatContextLimit, formatTokenCount } from "../../../shared/lib/formatTokens";
import { useLocale } from "../../../shared/hooks/useLocale";
import "./composerContextRing.css";

const SIZE = 16;
const STROKE = 2.25;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Ring beside the model chip. It reads the provider's own usage for the last
 * answered request, persisted on the session, so hovering never triggers a
 * stats request or history scan and the value never drifts from the provider.
 */
export function ComposerContextRing({
  usage,
}: {
  usage: ContextUsageSnapshot | null;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "top-end",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, {
    mouseOnly: true,
    delay: { open: 90, close: 140 },
    handleClose: safePolygon({ blockPointerEvents: false }),
  });
  const focus = useFocus(context);
  const dismiss = useDismiss(context, { escapeKey: true });
  const role = useRole(context, { role: "tooltip" });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
    dismiss,
    role,
  ]);

  if (!usage) return null;
  const limit = usage.limit;
  const windowPercent =
    limit && limit > 0
      ? Math.min(100, Math.max(0, (usage.total / limit) * 100))
      : null;
  const tone =
    windowPercent !== null && windowPercent >= 85
      ? "danger"
      : windowPercent !== null && windowPercent >= 70
        ? "warning"
        : "normal";
  const dash = windowPercent === null ? 0 : windowPercent / 100;
  const percentLabel =
    windowPercent === null ? "—" : `${Number(windowPercent.toFixed(1))}%`;
  const totalLabel = `${formatTokenCount(usage.total)}${
    limit ? ` / ${formatContextLimit(limit)}` : ""
  }`;
  const updatedAt = usage.measuredAt
    ? new Date(usage.measuredAt).toLocaleTimeString(
        zh ? "zh-CN" : "en-US",
        { hour: "2-digit", minute: "2-digit" },
      )
    : null;

  return (
    <span className="composer-context-ring shrink-0">
      <button
        type="button"
        ref={refs.setReference}
        {...getReferenceProps({
          "aria-label": zh
            ? `上下文占用 ${percentLabel}，${totalLabel}`
            : `Context usage ${percentLabel}, ${totalLabel}`,
          title: zh
            ? `上下文占用 ${percentLabel} · ${totalLabel}`
            : `Context usage ${percentLabel} · ${totalLabel}`,
          className: "composer-context-ring__trigger",
        })}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle
            className="composer-context-ring__track"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
          />
          <circle
            className="composer-context-ring__value"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - dash)}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            data-tone={tone}
          />
        </svg>
      </button>
      {open && (
        <Portal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps({
              className: "composer-context-ring__panel",
            })}
          >
            <div className="composer-context-ring__head">
              <span>{zh ? "上下文占用" : "Context usage"}</span>
              <span className="composer-context-ring__head-value">
                {percentLabel}
              </span>
            </div>
            <div className="composer-context-ring__total">
              <span>{totalLabel}</span>
              {updatedAt && (
                <span className="composer-context-ring__time">
                  {zh ? `${updatedAt} 更新` : `Updated ${updatedAt}`}
                </span>
              )}
            </div>
            <p className="composer-context-ring__note">
              {zh
                ? "服务商实测输入（含缓存），非账单用量。"
                : "Provider-reported input including cache. Not billed usage."}
            </p>
          </div>
        </Portal>
      )}
    </span>
  );
}
