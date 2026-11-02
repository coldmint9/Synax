import { readSessionAnalytics } from '../analytics-projection.js';
import { contentText } from '../content-parts.js';
import type {
  AgentRuntimeMessage,
  AgentSession,
  AgentSessionStatus,
} from '../contracts.js';
import { projectSessionState } from '../session-projection.js';
import type {
  SessionAnalyticsSummary,
  SessionChildStatus,
  SessionListItem,
  SessionSearchHit,
  SessionStatusItem,
} from './contracts.js';

const PROMPT_PREVIEW_LIMIT = 160;
const REASON_LIMIT = 400;
const CHILD_LIMIT = 20;

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncateText(value: string, limit: number): string {
  const normalized = collapseWhitespace(value);
  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(0, limit - 1))}…`
    : normalized;
}

export function truncateNullable(
  value: string | null,
  limit: number,
): string | null {
  if (!value?.trim()) return null;
  return truncateText(value, limit);
}

/** Archived sessions stay readable; deleted and fork-preparing rows do not exist yet. */
export function isVisibleSession(
  session: AgentSession,
  includeArchived: boolean,
): boolean {
  const metadata = session.sessionMetadata ?? {};
  if (metadata.deletedAt || metadata.forkPreparing) return false;
  return includeArchived || !metadata.archivedAt;
}

export interface SessionFilterOptions {
  projectId?: string | null;
  includeChildren?: boolean;
  includeArchived?: boolean;
  statuses?: readonly AgentSessionStatus[];
}

export function sessionStatusOf(session: AgentSession): AgentSessionStatus {
  return projectSessionState(session).status;
}

export function selectSessions(
  sessions: readonly AgentSession[],
  options: SessionFilterOptions = {},
): AgentSession[] {
  const statuses = options.statuses?.length
    ? new Set(options.statuses)
    : null;
  return sessions.filter((session) => {
    if (!isVisibleSession(session, options.includeArchived ?? false))
      return false;
    if (options.projectId && session.projectId !== options.projectId)
      return false;
    if (!options.includeChildren && session.parentSessionId) return false;
    if (statuses && !statuses.has(sessionStatusOf(session))) return false;
    return true;
  });
}

const pinnedRank = (session: AgentSession) =>
  session.sessionMetadata?.pinned ? 1 : 0;

/** Pinned rows first, then most recently active; ids keep the order stable. */
export function compareSessions(a: AgentSession, b: AgentSession): number {
  return (
    pinnedRank(b) - pinnedRank(a) ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    b.id.localeCompare(a.id)
  );
}

export function countByStatus(
  sessions: readonly AgentSession[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) {
    const status = sessionStatusOf(session);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

export function sessionTitle(session: AgentSession): string | null {
  const title = session.title?.trim();
  return title ? collapseWhitespace(title) : null;
}

export function toSessionListItem(session: AgentSession): SessionListItem {
  return {
    id: session.id,
    title: sessionTitle(session),
    projectId: session.projectId,
    profileId: session.profileId,
    status: sessionStatusOf(session),
    parentSessionId: session.parentSessionId,
    nodeId: session.nodeId,
    pinned: pinnedRank(session) === 1,
    archived: Boolean(session.sessionMetadata?.archivedAt),
    activeRunId: session.activeRunId,
    blockedReason: truncateNullable(session.blockedReason, REASON_LIMIT),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    promptPreview: truncateText(session.prompt, PROMPT_PREVIEW_LIMIT),
  };
}

function analyticsSummary(session: AgentSession): SessionAnalyticsSummary | null {
  const analytics = readSessionAnalytics(
    session.sessionMetadata?.runtimeAnalytics,
  );
  if (!analytics) return null;
  return {
    steps: analytics.steps,
    completedRuns: analytics.completedRuns,
    completedRunSteps: analytics.completedRunSteps,
    toolCalls: analytics.toolCalls,
    lastStepId: analytics.lastStepId,
    lastCompletedRunId: analytics.lastCompletedRunId,
    updatedAt: analytics.updatedAt,
  };
}

export function toSessionStatusItem(
  session: AgentSession,
  children: readonly AgentSession[] = [],
): SessionStatusItem {
  return {
    id: session.id,
    title: sessionTitle(session),
    projectId: session.projectId,
    profileId: session.profileId,
    status: sessionStatusOf(session),
    parentSessionId: session.parentSessionId,
    activeRunId: session.activeRunId,
    blockedReason: truncateNullable(session.blockedReason, REASON_LIMIT),
    pendingResumeToken: session.pendingResumeToken,
    resultSummary: truncateNullable(session.resultSummary, REASON_LIMIT),
    runtimeRecoveryRequired: Boolean(session.runtimeRecoveryRequired),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    analytics: analyticsSummary(session),
    children: [...children]
      .sort(compareSessions)
      .slice(0, CHILD_LIMIT)
      .map(
        (child): SessionChildStatus => ({
          id: child.id,
          title: sessionTitle(child),
          status: sessionStatusOf(child),
          activeRunId: child.activeRunId,
        }),
      ),
  };
}

/** Text a message contributes to search; media parts contribute nothing. */
export function messageText(message: AgentRuntimeMessage): string {
  const parts = message.contentParts;
  const fromParts = parts?.length ? contentText(parts) : '';
  return fromParts || message.content || '';
}

export function firstMatchIndex(
  text: string,
  lowerQuery: string,
): number {
  return text.toLocaleLowerCase().indexOf(lowerQuery);
}

export function countMatches(
  text: string,
  lowerQuery: string,
  cap = 20,
): number {
  const lower = text.toLocaleLowerCase();
  let count = 0;
  let from = 0;
  while (count < cap) {
    const index = lower.indexOf(lowerQuery, from);
    if (index < 0) break;
    count++;
    from = index + lowerQuery.length;
  }
  return count;
}

export function snippetAround(
  text: string,
  index: number,
  length: number,
  radius = 80,
): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return [
    start > 0 ? '…' : '',
    collapseWhitespace(text.slice(start, end)),
    end < text.length ? '…' : '',
  ].join('');
}

const HIT_KIND_ORDER: Record<SessionSearchHit['kind'], number> = {
  title: 0,
  prompt: 1,
  message: 2,
};

/** Newest session first; within a session, title/prompt precede messages. */
export function compareSearchHits(
  a: SessionSearchHit,
  b: SessionSearchHit,
): number {
  return (
    b.sessionUpdatedAt.localeCompare(a.sessionUpdatedAt) ||
    a.sessionId.localeCompare(b.sessionId) ||
    HIT_KIND_ORDER[a.kind] - HIT_KIND_ORDER[b.kind] ||
    (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  );
}
