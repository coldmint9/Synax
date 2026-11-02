import type { AgentSession } from '../contracts.js';
import { agentRuntimeStore } from '../session-store.js';
import type {
  SessionListQuery,
  SessionListResult,
  SessionQueryScope,
  SessionReader,
  SessionSearchHit,
  SessionSearchQuery,
  SessionSearchResult,
  SessionStatusQuery,
  SessionStatusResult,
} from './contracts.js';
import { SessionQueryError } from './errors.js';
import {
  compareSearchHits,
  compareSessions,
  countByStatus,
  countMatches,
  firstMatchIndex,
  isVisibleSession,
  messageText,
  selectSessions,
  sessionStatusOf,
  sessionTitle,
  snippetAround,
  toSessionListItem,
  toSessionStatusItem,
} from './query.js';

/** A single transcript can be long; keep one chatty session from flooding the result. */
const MESSAGE_HITS_PER_SESSION = 3;
const COLLECTED_HIT_FLOOR = 30;

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class SessionQueryService {
  constructor(
    private readonly reader: SessionReader,
    private readonly workspaceForSession: (sessionId: string) => string = (
      sessionId,
    ) => agentRuntimeStore.getSession(sessionId).projectId,
  ) {}

  async list(
    input: SessionListQuery,
    currentSessionId: string,
  ): Promise<SessionListResult> {
    const projectId = await this.projectScope(
      input.scope,
      input.projectId,
      currentSessionId,
    );
    const sessions = await this.reader.listSessions();
    const selected = selectSessions(sessions, {
      projectId,
      includeChildren: input.includeChildren,
      includeArchived: input.includeArchived,
      statuses: input.status,
    }).sort(compareSessions);
    const page = selected.slice(input.offset, input.offset + input.limit);
    const nextOffset = input.offset + page.length;
    const hasMore = nextOffset < selected.length;
    return {
      scope: input.scope,
      projectId,
      items: page.map(toSessionListItem),
      totalCount: selected.length,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
      countByStatus: countByStatus(selected),
    };
  }

  async status(
    input: SessionStatusQuery,
    currentSessionId: string,
  ): Promise<SessionStatusResult> {
    const ids = dedupe(input.sessionIds?.length ? input.sessionIds : [currentSessionId]);
    const settled = await Promise.allSettled(
      ids.map((id) => this.reader.getSession(id)),
    );
    const sessions: AgentSession[] = [];
    const missing: string[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') {
        if (result.value.sessionMetadata?.deletedAt) {
          missing.push(ids[index]);
          continue;
        }
        sessions.push(result.value);
        continue;
      }
      if (
        result.reason instanceof SessionQueryError &&
        result.reason.code === 'SESSION_NOT_FOUND'
      ) {
        missing.push(ids[index]);
        continue;
      }
      throw result.reason;
    }
    if (!sessions.length)
      throw new SessionQueryError(
        'SESSION_NOT_FOUND',
        ids.length === 1
          ? `Session ${ids[0]} was not found.`
          : 'None of the requested sessions were found.',
      );
    const all = input.includeChildren ? await this.reader.listSessions() : [];
    return {
      items: sessions.map((session) =>
        toSessionStatusItem(
          session,
          all.filter(
            (candidate) =>
              candidate.parentSessionId === session.id &&
              isVisibleSession(candidate, false),
          ),
        ),
      ),
      missing,
    };
  }

  async search(
    input: SessionSearchQuery,
    currentSessionId: string,
  ): Promise<SessionSearchResult> {
    const explicit = input.sessionIds?.length
      ? new Set(input.sessionIds)
      : null;
    const projectId = explicit
      ? null
      : await this.projectScope(
          input.scope,
          input.projectId,
          currentSessionId,
        );
    const sessions = await this.reader.listSessions();
    const missing: string[] = [];
    let candidates: AgentSession[];
    if (explicit) {
      candidates = sessions.filter(
        (session) =>
          explicit.has(session.id) &&
          !session.sessionMetadata?.deletedAt &&
          !session.sessionMetadata?.forkPreparing,
      );
      for (const id of explicit)
        if (!candidates.some((session) => session.id === id)) missing.push(id);
      if (!candidates.length)
        throw new SessionQueryError(
          'SESSION_NOT_FOUND',
          `None of the requested sessions were found: ${[...explicit].join(', ')}.`,
        );
    } else {
      candidates = selectSessions(sessions, {
        projectId,
        includeChildren: input.includeChildren,
        includeArchived: input.includeArchived,
      });
    }
    const ordered = [...candidates].sort(compareSessions);
    const scoped = ordered.slice(0, input.maxSessions);
    const lowerQuery = input.query.toLocaleLowerCase();
    const collectedCap = Math.max(
      input.limit * 3,
      COLLECTED_HIT_FLOOR,
    );
    const roles = new Set(input.roles);
    const hits: SessionSearchHit[] = [];
    const hitBase = (session: AgentSession) => ({
      sessionId: session.id,
      title: sessionTitle(session),
      status: sessionStatusOf(session),
      sessionUpdatedAt: session.updatedAt,
    });

    if (input.includeTitleMatches)
      for (const session of scoped) {
        if (hits.length >= collectedCap) break;
        const title = sessionTitle(session);
        const titleIndex = title ? firstMatchIndex(title, lowerQuery) : -1;
        if (title && titleIndex >= 0) {
          hits.push({
            ...hitBase(session),
            kind: 'title',
            messageId: null,
            role: null,
            createdAt: session.createdAt,
            snippet: snippetAround(title, titleIndex, input.query.length, 40),
            matchCount: countMatches(title, lowerQuery),
          });
          continue;
        }
        const promptIndex = session.prompt
          ? firstMatchIndex(session.prompt, lowerQuery)
          : -1;
        if (promptIndex < 0) continue;
        hits.push({
          ...hitBase(session),
          kind: 'prompt',
          messageId: null,
          role: null,
          createdAt: session.createdAt,
          snippet: snippetAround(
            session.prompt,
            promptIndex,
            input.query.length,
          ),
          matchCount: countMatches(session.prompt, lowerQuery),
        });
      }

    let scannedSessions = 0;
    for (const session of scoped) {
      if (hits.length >= input.limit || hits.length >= collectedCap) break;
      const messages = await this.reader.listMessages(session.id);
      scannedSessions++;
      let perSession = 0;
      for (const message of messages) {
        if (perSession >= MESSAGE_HITS_PER_SESSION) break;
        if (hits.length >= collectedCap) break;
        if (!roles.has(message.role)) continue;
        const text = messageText(message);
        if (!text) continue;
        const index = firstMatchIndex(text, lowerQuery);
        if (index < 0) continue;
        hits.push({
          ...hitBase(session),
          kind: 'message',
          messageId: message.id,
          role: message.role,
          createdAt: message.createdAt,
          snippet: snippetAround(text, index, input.query.length),
          matchCount: countMatches(text, lowerQuery),
        });
        perSession++;
      }
    }

    const items = [...hits]
      .sort(compareSearchHits)
      .slice(0, input.limit);
    return {
      query: input.query,
      scope: explicit ? 'sessions' : input.scope,
      projectId,
      candidateSessions: ordered.length,
      scannedSessions,
      truncated:
        ordered.length > scoped.length ||
        scannedSessions < scoped.length ||
        hits.length >= collectedCap ||
        items.length < hits.length,
      items,
      missing,
    };
  }

  private async projectScope(
    scope: SessionQueryScope,
    projectId: string | undefined,
    currentSessionId: string,
  ): Promise<string | null> {
    if (scope === 'all') return null;
    if (projectId) return projectId;
    try {
      return this.workspaceForSession(currentSessionId);
    } catch {
      try {
        return (await this.reader.getSession(currentSessionId)).projectId;
      } catch {
        throw new SessionQueryError(
          'SESSION_NOT_FOUND',
          'The current session workspace could not be resolved. Pass projectId or use scope all.',
        );
      }
    }
  }
}
