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

const CATEGORIES = [
  {
    key: "messages",
    zh: "消息",
    en: "Messages",
    color: "var(--profile-messages)",
  },
  { key: "tools", zh: "工具", en: "Tools", color: "var(--profile-tools)" },
  { key: "mcp", zh: "MCP", en: "MCP", color: "var(--profile-mcp)" },
  { key: "skills", zh: "技能", en: "Skills", color: "var(--profile-skills)" },
  {
    key: "system",
    zh: "系统提示词",
    en: "System prompt",
    color: "var(--profile-system)",
  },
] as const;

const percentOf = (value: number, total: number) =>
  total > 0 ? (value / total) * 100 : 0;

/**
 * Ring beside the model chip. It reads the request-context snapshot persisted
 * on the session, so hovering never triggers a stats request or history scan.
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
  const composition = usage.composition;
  const values = CATEGORIES.map((category) => ({
    ...category,
    value: Math.max(0, Number(composition[category.key] ?? 0) || 0),
  }));
  const classified = values.reduce((sum, item) => sum + item.value, 0);
  const withValues = values.filter((item) => item.value > 0);
  const remainder = Math.max(0, usage.total - classified);
  const percentLabel =
    windowPercent === null ? "—" : `${Number(windowPercent.toFixed(1))}%`;
  const totalLabel = `${formatTokenCount(usage.total)}${
    limit ? ` / ${formatContextLimit(limit)}` : ""
  }`;
  const measured = usage.measuredAt
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
              {measured && (
                <span className="composer-context-ring__time">
                  {zh ? `${measured} 更新` : `Updated ${measured}`}
                </span>
              )}
            </div>
            <ul className="composer-context-ring__rows">
              {withValues.map((item) => {
                const share = percentOf(item.value, usage.total);
                return (
                  <li key={item.key}>
                    <span
                      className="composer-context-ring__dot"
                      style={{ background: item.color }}
                      aria-hidden="true"
                    />
                    <span className="composer-context-ring__label">
                      {zh ? item.zh : item.en}
                    </span>
                    <span className="composer-context-ring__count">
                      {formatTokenCount(item.value)}
                    </span>
                    <span className="composer-context-ring__share">
                      {share.toFixed(1)}%
                    </span>
                    <span className="composer-context-ring__bar" aria-hidden="true">
                      <span
                        style={{
                          width: `${Math.min(100, share)}%`,
                          background: item.color,
                        }}
                      />
                    </span>
                  </li>
                );
              })}
              {remainder > 0 && (
                <li>
                  <span
                    className="composer-context-ring__dot"
                    style={{ background: "var(--ui-line)" }}
                    aria-hidden="true"
                  />
                  <span className="composer-context-ring__label">
                    {zh ? "其他" : "Other"}
                  </span>
                  <span className="composer-context-ring__count">
                    {formatTokenCount(remainder)}
                  </span>
                  <span className="composer-context-ring__share">
                    {percentOf(remainder, usage.total).toFixed(1)}%
                  </span>
                  <span className="composer-context-ring__bar" aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.min(100, percentOf(remainder, usage.total))}%`,
                        background: "var(--ui-line)",
                      }}
                    />
                  </span>
                </li>
              )}
            </ul>
            <p className="composer-context-ring__note">
              {zh
                ? "本地分类估算，随每次请求增量更新；非账单用量。"
                : "Local category estimate, updated incrementally per request; not billed usage."}
            </p>
          </div>
        </Portal>
      )}
    </span>
  );
}
