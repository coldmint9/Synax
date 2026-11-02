import type {
  AgentRuntimeMessage,
  AgentSession,
} from '../contracts.js';
import { logger } from '../../../infrastructure/runtime/logger.js';
import { selectSessions } from './query.js';
import {
  MAX_INDEXED_MESSAGES,
  buildProjectionDocument,
  buildSessionSearchDocument,
  compactDocument,
  sessionStamp,
  type SessionSearchDocument,
} from './search-documents.js';
import {
  SEARCH_KIND_ORDER,
  evaluateDocument,
  queryTerms,
  type SessionSearchMatch,
} from './search-evaluation.js';
import {
  FileSessionSearchStore,
  MAX_STORED_CHARS,
  type SessionSearchStore,
} from './search-store.js';

/** Transcript reads are the expensive part: two at a time keeps the host calm. */
const INDEX_BUILD_CONCURRENCY = 2;
/** One search queues a bounded slice; the rest follows on the next keystroke. */
const INDEX_BUILD_BACKLOG = 32;
/** A session that is still streaming is re-read at most this often. */
const RUNNING_REINDEX_INTERVAL_MS = 60_000;
/** A transcript read that failed is retried after this pause. */
const FAILED_REINDEX_INTERVAL_MS = 30_000;
/** Coalesce index writes: a burst of builds must not rewrite the file per build. */
const SAVE_DEBOUNCE_MS = 1_500;
/** Only the workspaces the user is actually cycling through stay in memory. */
const MAX_CACHED_PROJECTS = 3;

export interface SessionSearchSource {
  listSessions(): Promise<readonly AgentSession[]>;
  listRecentMessages(
    sessionId: string,
    limit: number,
  ): Promise<readonly AgentRuntimeMessage[]>;
}

export interface SessionSearchInput {
  projectId: string;
  query: string;
  limit: number;
  offset: number;
}

export interface SessionSearchItem extends SessionSearchMatch {
  session: AgentSession;
}

export interface SessionSearchIndexing {
  /** Sessions answered from an up-to-date index. */
  ready: number;
  /** Sessions whose transcript is queued or being read right now. */
  pending: number;
  total: number;
}

export interface SessionSearchOutcome {
  items: SessionSearchItem[];
  hasMore: boolean;
  terms: string[];
  indexing: SessionSearchIndexing;
}

interface ProjectState {
  projectId: string;
  documents: Map<string, SessionSearchDocument>;
  /** Title/prompt views for sessions without a finished transcript index. */
  projections: Map<string, SessionSearchDocument>;
  loaded: Promise<void> | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  saving: Promise<void> | null;
  dirty: boolean;
  chars: number;
  lastUsed: number;
}

interface BuildJob {
  projectId: string;
  session: AgentSession;
}

function projectKey(projectId: string, sessionId: string): string {
  return `${projectId}\u0000${sessionId}`;
}

function isLive(session: AgentSession): boolean {
  return Boolean(session.activeRunId) || session.status === 'running';
}

/**
 * Keeps the newest match: the label a user recognizes beats a message body, and
 * more occurrences win a tie.
 */
function preferMatch(
  left: SessionSearchMatch | null,
  right: SessionSearchMatch | null,
): SessionSearchMatch | null {
  if (!left) return right;
  if (!right) return left;
  const kind = SEARCH_KIND_ORDER[left.kind] - SEARCH_KIND_ORDER[right.kind];
  if (kind !== 0) return kind < 0 ? left : right;
  return right.matchCount > left.matchCount ? right : left;
}

function compareItems(left: SessionSearchItem, right: SessionSearchItem): number {
  return (
    right.session.updatedAt.localeCompare(left.session.updatedAt) ||
    SEARCH_KIND_ORDER[left.kind] - SEARCH_KIND_ORDER[right.kind] ||
    right.matchCount - left.matchCount ||
    right.session.id.localeCompare(left.session.id)
  );
}

/**
 * Keyword search over a workspace's conversations.
 *
 * Each session is summarized once into a compact normalized document (title,
 * prompt and the newest user/assistant text) and persisted compressed, so a
 * keystroke scans memory instead of re-reading every JSONL transcript. Sessions
 * are indexed lazily in the background: the first search still answers from the
 * session projection, and the client refreshes while `indexing.pending` drops.
 */
export class SessionSearchService {
  private readonly projects = new Map<string, ProjectState>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly blockedUntil = new Map<string, number>();
  private readonly lastAttempt = new Map<string, number>();
  private readonly queue: BuildJob[] = [];
  private active = 0;

  constructor(
    private readonly source: SessionSearchSource,
    private readonly store: SessionSearchStore = new FileSessionSearchStore(),
    private readonly now: () => number = Date.now,
  ) {}

  async search(input: SessionSearchInput): Promise<SessionSearchOutcome> {
    const terms = queryTerms(input.query);
    const offset = Math.max(0, Math.trunc(input.offset));
    const limit = Math.max(1, Math.trunc(input.limit));
    if (!terms.length)
      return {
        items: [],
        hasMore: false,
        terms,
        indexing: { ready: 0, pending: 0, total: 0 },
      };

    const state = this.project(input.projectId);
    await this.ensureLoaded(state);

    const sessions = selectSessions(await this.source.listSessions(), {
      projectId: input.projectId,
      includeArchived: false,
    });

    const items: SessionSearchItem[] = [];
    let ready = 0;
    let pending = 0;
    for (const session of sessions) {
      const indexed = state.documents.get(session.id);
      const fresh = indexed?.stamp === sessionStamp(session);
      if (fresh) ready += 1;
      let match = indexed ? evaluateDocument(indexed, terms) : null;
      if (!fresh) {
        // The projection is already in memory, so a title hit never waits for
        // the transcript index; a stale index still answers in the meantime.
        const projection = this.projection(state, session);
        match = preferMatch(evaluateDocument(projection, terms), match);
        const key = projectKey(state.projectId, session.id);
        if (this.enqueue(state, session) || this.isPending(key)) pending += 1;
      }
      if (match) items.push({ session, ...match });
    }

    this.prune(state, sessions);
    items.sort(compareItems);
    return {
      items: items.slice(offset, offset + limit),
      hasMore: items.length > offset + limit,
      terms,
      indexing: { ready, pending, total: sessions.length },
    };
  }

  private project(projectId: string): ProjectState {
    const existing = this.projects.get(projectId);
    if (existing) {
      existing.lastUsed = this.now();
      return existing;
    }
    const state: ProjectState = {
      projectId,
      documents: new Map(),
      projections: new Map(),
      loaded: null,
      saveTimer: null,
      saving: null,
      dirty: false,
      chars: 0,
      lastUsed: this.now(),
    };
    this.projects.set(projectId, state);
    if (this.projects.size > MAX_CACHED_PROJECTS) this.evictIdleProject(projectId);
    return state;
  }

  /** Evicted workspaces reload from their compressed cache on the next search. */
  private evictIdleProject(keepProjectId: string): void {
    const victim = [...this.projects.values()]
      .filter((state) => state.projectId !== keepProjectId)
      .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    if (!victim) return;
    if (victim.saveTimer) {
      clearTimeout(victim.saveTimer);
      victim.saveTimer = null;
    }
    this.projects.delete(victim.projectId);
    if (victim.dirty)
      void this.store.save(victim.projectId, [...victim.documents.values()]).catch(
        (error) =>
          logger.warn(
            { projectId: victim.projectId, err: error },
            '[session-search] index write failed',
          ),
      );
  }

  private async ensureLoaded(state: ProjectState): Promise<void> {
    if (!state.loaded)
      state.loaded = (async () => {
        let documents: SessionSearchDocument[] = [];
        try {
          documents = await this.store.load(state.projectId);
        } catch (error) {
          // A cache that cannot be read is a cold index, not a failed search.
          logger.warn(
            { projectId: state.projectId, err: error },
            '[session-search] index read failed',
          );
        }
        for (const document of documents) {
          state.documents.set(document.sessionId, document);
          state.chars += document.chars;
        }
      })();
    await state.loaded;
  }

  private projection(
    state: ProjectState,
    session: AgentSession,
  ): SessionSearchDocument {
    const stamp = sessionStamp(session);
    const cached = state.projections.get(session.id);
    if (cached?.stamp === stamp) return cached;
    const document = buildProjectionDocument(session);
    state.projections.set(session.id, document);
    return document;
  }

  private prune(
    state: ProjectState,
    sessions: readonly AgentSession[],
  ): void {
    if (
      state.projections.size <= sessions.length &&
      this.blockedUntil.size + this.lastAttempt.size < 20_000
    )
      return;
    const live = new Set(sessions.map((session) => session.id));
    for (const sessionId of state.projections.keys())
      if (!live.has(sessionId)) state.projections.delete(sessionId);
    const prefix = `${state.projectId}\u0000`;
    for (const key of this.blockedUntil.keys())
      if (key.startsWith(prefix) && !live.has(key.slice(prefix.length)))
        this.blockedUntil.delete(key);
    for (const key of this.lastAttempt.keys())
      if (key.startsWith(prefix) && !live.has(key.slice(prefix.length)))
        this.lastAttempt.delete(key);
  }

  private isPending(key: string): boolean {
    return this.inFlight.has(key) || this.queue.some(
      (job) => projectKey(job.projectId, job.session.id) === key,
    );
  }

  /** Returns true when this call actually asked for a transcript read. */
  private enqueue(state: ProjectState, session: AgentSession): boolean {
    const key = projectKey(state.projectId, session.id);
    if (this.inFlight.has(key)) return false;
    if (this.blockedUntil.has(key)) return false;
    if (
      this.queue.some(
        (job) => projectKey(job.projectId, job.session.id) === key,
      )
    )
      return false;
    const attempted = this.lastAttempt.get(key);
    if (
      attempted !== undefined &&
      isLive(session) &&
      this.now() - attempted < RUNNING_REINDEX_INTERVAL_MS
    )
      return false;
    if (this.queue.length >= INDEX_BUILD_BACKLOG * 4) return false;
    this.queue.push({ projectId: state.projectId, session });
    this.pump();
    return true;
  }

  private pump(): void {
    while (this.active < INDEX_BUILD_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      const key = projectKey(job.projectId, job.session.id);
      this.active += 1;
      this.lastAttempt.set(key, this.now());
      const run = this.build(job)
        .catch((error) => {
          this.blockedUntil.set(key, this.now() + FAILED_REINDEX_INTERVAL_MS);
          logger.warn(
            { sessionId: job.session.id, err: error },
            '[session-search] transcript indexing failed',
          );
        })
        .finally(() => {
          this.inFlight.delete(key);
          this.active -= 1;
          this.pump();
        });
      this.inFlight.set(key, run);
    }
  }

  private async build(job: BuildJob): Promise<void> {
    const messages = await this.source.listRecentMessages(
      job.session.id,
      MAX_INDEXED_MESSAGES,
    );
    const state = this.projects.get(job.projectId);
    if (!state) return;
    this.putDocument(state, buildSessionSearchDocument(job.session, messages));
  }

  private putDocument(
    state: ProjectState,
    document: SessionSearchDocument,
  ): void {
    const previous = state.documents.get(document.sessionId);
    if (previous) state.chars -= previous.chars;
    state.documents.set(document.sessionId, document);
    state.chars += document.chars;
    this.trimToBudget(state);
    state.dirty = true;
    this.scheduleSave(state);
  }

  /**
   * Memory and disk share one budget. The oldest conversations keep their label
   * and lose their message text, so a huge workspace neither exhausts memory nor
   * re-reads the same transcripts on every search.
   */
  private trimToBudget(state: ProjectState): void {
    if (state.chars <= MAX_STORED_CHARS) return;
    const ordered = [...state.documents.values()]
      .filter((document) =>
        document.segments.some((segment) => segment.kind === 'message'),
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const document of ordered) {
      if (state.chars <= MAX_STORED_CHARS) break;
      const compacted = compactDocument(document);
      state.chars -= document.chars - compacted.chars;
      state.documents.set(document.sessionId, compacted);
    }
  }

  private scheduleSave(state: ProjectState): void {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      void this.flush(state);
    }, SAVE_DEBOUNCE_MS);
    // A pending cache write must not keep the host process alive.
    state.saveTimer.unref?.();
  }

  private async flush(state: ProjectState): Promise<void> {
    if (state.saving) return state.saving;
    if (!state.dirty) return;
    state.dirty = false;
    const documents = [...state.documents.values()];
    state.saving = this.store
      .save(state.projectId, documents)
      .catch((error) => {
        state.dirty = true;
        logger.warn(
          { projectId: state.projectId, err: error },
          '[session-search] index write failed',
        );
      })
      .finally(() => {
        state.saving = null;
      });
    return state.saving;
  }

  /** Waits for queued reads and the pending index write; used on shutdown/tests. */
  async settle(): Promise<void> {
    while (this.queue.length || this.active || this.inFlight.size) {
      const running = [...this.inFlight.values()];
      if (!running.length) break;
      await Promise.all(running);
    }
    for (const state of this.projects.values()) {
      if (state.saveTimer) {
        clearTimeout(state.saveTimer);
        state.saveTimer = null;
      }
      await this.flush(state);
    }
  }

  /**
   * Drops every in-memory index, queue and retry fence, so the next search
   * starts from the persisted cache. Fixtures call it after {@link settle}.
   */
  reset(): void {
    this.queue.length = 0;
    this.projects.clear();
    this.inFlight.clear();
    this.blockedUntil.clear();
    this.lastAttempt.clear();
  }
}

/** Adapter: the runtime facade is the only reader of authoritative history. */
export function createRuntimeSessionSearchSource(): SessionSearchSource {
  return {
    listSessions: async () => {
      const { runtimeFacade } = await import('../sidecar/runtime-facade.js');
      const { projectSessionState } = await import('../session-projection.js');
      return (await runtimeFacade.listSessionProjection()).map((item) =>
        projectSessionState(item as never),
      );
    },
    listRecentMessages: async (sessionId, limit) => {
      const { runtimeFacade } = await import('../sidecar/runtime-facade.js');
      return runtimeFacade.listRecentMessages(
        sessionId,
        limit,
      ) as Promise<AgentRuntimeMessage[]>;
    },
  };
}

export const sessionSearchService = new SessionSearchService(
  createRuntimeSessionSearchSource(),
);
