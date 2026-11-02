import type { AgentSession } from "../../adapters/transport/agentRuntime";
import type { SessionGroup, SessionTreeNode } from "./useSessionList";
import { summarizeSessionDots } from "./sessionStatusDot";

export interface IntentGroupOptions {
  /** Heading for sessions that asynchronous title generation has not labelled. */
  uncategorized: string;
  /** Read state per session: a read result stops contributing a status dot. */
  isUnread: (session: AgentSession) => boolean;
}

function readIntentCategory(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const value = metadata?.intentCategory;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Cluster list rows by the intent category that title generation wrote.
 *
 * Rows arrive newest-first, so category order is most-recently-active first
 * without a second sort, and the uncategorized remainder always trails.
 */
export function buildIntentSessionGroups(
  nodes: SessionTreeNode[],
  options: IntentGroupOptions,
): SessionGroup[] {
  const buckets = new Map<string, SessionTreeNode[]>();
  const order: string[] = [];
  for (const node of nodes) {
    const label =
      readIntentCategory(node.session.sessionMetadata) ?? options.uncategorized;
    const rows = buckets.get(label);
    if (rows) rows.push(node);
    else {
      buckets.set(label, [node]);
      order.push(label);
    }
  }

  const groups: SessionGroup[] = order.map((label) => {
    const rows = buckets.get(label) ?? [];
    return {
      key: `intent:${label}`,
      label,
      sessions: rows,
      collapsible: true,
      statusCounts: summarizeSessionDots(
        rows.map((node) => ({
          status: node.session.status,
          unread: options.isUnread(node.session),
        })),
      ),
      collapsed: false,
      count: rows.length,
    };
  });

  // Unlabelled work is the remainder, so it never outranks a real category.
  const uncategorized = groups.findIndex(
    (group) => group.label === options.uncategorized,
  );
  if (uncategorized >= 0) groups.push(...groups.splice(uncategorized, 1));
  return groups;
}
