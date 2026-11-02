import { Tooltip } from "@/shared/ui/ui/Tooltip";
import { ToolbarBadge } from "./ToolbarBadge";
import type { GitUnpushedState } from "./useGitUnpushed";

/** Formatters are immutable per locale; building one per render would churn. */
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatSince(locale: string, since: string): string | null {
  const date = new Date(since);
  if (Number.isNaN(date.getTime())) return null;
  let formatter = timeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    timeFormatters.set(locale, formatter);
  }
  return formatter.format(date);
}

/**
 * "3 unpushed commits · oldest Oct 31, 14:32" — the count is the reminder, the
 * timestamp explains how long the oldest commit has been waiting.
 */
export function gitUnpushedDescription(
  unpushed: GitUnpushedState,
  locale: string,
): string | null {
  if (unpushed.count <= 0) return null;
  const time = unpushed.since ? formatSince(locale, unpushed.since) : null;
  if (locale === "zh") {
    return time
      ? `${unpushed.count} 个提交未推送 · 最早提交 ${time}`
      : `${unpushed.count} 个提交未推送`;
  }
  const noun = unpushed.count === 1 ? "commit" : "commits";
  return time
    ? `${unpushed.count} unpushed ${noun} · oldest ${time}`
    : `${unpushed.count} unpushed ${noun}`;
}

/**
 * Badge on the Git switch. It is informational only: clicking never opens a
 * menu and never toggles the panel, it just reveals when the work was committed.
 */
export function GitUnpushedBadge({
  unpushed,
  locale,
}: {
  unpushed: GitUnpushedState;
  locale: string;
}) {
  const description = gitUnpushedDescription(unpushed, locale);
  if (!description) return null;
  return (
    <Tooltip content={description} openOnClick>
      <ToolbarBadge
        count={unpushed.count}
        tone="attention"
        className="wh-tab__badge"
        onClick={(event) => event.stopPropagation()}
      />
    </Tooltip>
  );
}
