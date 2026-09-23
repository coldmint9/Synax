import type { SystemModelMessage } from "@ai-sdk/provider-utils";
import type { HistoryCacheAnchor } from "../llm-runtime/cache-policy.js";
import { createHash } from "node:crypto";

/** Persisted before dispatch, replayed verbatim. Never re-render an earlier step's state. */
export interface RuntimeReminderSnapshot {
  version: 1;
  content: string;
  fingerprint: string;
  queuedInputIds: string[];
  /** Identity of the marker-free historical prefix, owned by this persisted step. */
  historyAnchor?: HistoryCacheAnchor;
}

export function readRuntimeReminder(
  metadata?: Record<string, unknown> | null,
): RuntimeReminderSnapshot | undefined {
  const value = metadata?.runtimeReminder as
    | Partial<RuntimeReminderSnapshot>
    | undefined;
  if (
    !value ||
    value.version !== 1 ||
    typeof value.content !== "string" ||
    typeof value.fingerprint !== "string" ||
    !Array.isArray(value.queuedInputIds) ||
    !value.queuedInputIds.every((id) => typeof id === "string")
  )
    return undefined;
  return value as RuntimeReminderSnapshot;
}

export function snapshotRuntimeReminder(
  metadata: Record<string, unknown>,
  sections: string[],
  queuedInputIds: string[],
): RuntimeReminderSnapshot {
  const saved = readRuntimeReminder(metadata);
  if (saved) return saved;
  const content = `<system-reminder>\n${sections.filter(Boolean).join("\n")}\n</system-reminder>`;
  return {
    version: 1,
    content,
    fingerprint: createHash("sha256").update(content).digest("hex"),
    queuedInputIds: [...queuedInputIds],
  };
}

/** Runtime state is not a human turn, including when replaying persisted snapshots. */
export function runtimeReminderMessage(
  reminder: Pick<RuntimeReminderSnapshot, "content">,
): SystemModelMessage {
  return { role: "system", content: reminder.content };
}
