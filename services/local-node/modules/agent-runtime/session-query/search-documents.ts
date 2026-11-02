import type {
  AgentRuntimeMessage,
  AgentSession,
  RuntimeMessageRole,
} from '../contracts.js';
import { messageText } from './query.js';

/**
 * Conversation search reads one normalized document per session instead of the
 * transcript on every keystroke. The document keeps only the text a keyword can
 * match: no ids, tool output, run metadata or media, so its size stays a small
 * fraction of the JSONL history it stands in for.
 */

/** Tool and system output is not a conversation hit the user can recognize. */
const SEARCHED_ROLES: ReadonlySet<RuntimeMessageRole> = new Set([
  'user',
  'assistant',
]);

/** Newest messages win the budget; older ones only matter for recall. */
export const MAX_INDEXED_MESSAGES = 80;
export const MAX_INDEXED_MESSAGE_CHARS = 4_000;
export const MAX_INDEXED_SESSION_CHARS = 48_000;
/** A title is a label, not content; a prompt mirrors the first message. */
const MAX_INDEXED_TITLE_CHARS = 300;
const MAX_INDEXED_PROMPT_CHARS = 4_000;

/** Matching a single keyword stops after this many hits: counts only rank rows. */
export const MAX_MATCHES_PER_TERM = 40;

export type SearchSegmentKind = 'title' | 'prompt' | 'message';

export interface SearchSegment {
  kind: SearchSegmentKind;
  messageId: string | null;
  role: RuntimeMessageRole | null;
  createdAt: string | null;
  /** Offsets into `haystack`; segments never overlap. */
  start: number;
  end: number;
}

export interface SessionSearchDocument {
  sessionId: string;
  /** Projection fingerprint of the transcript this document was built from. */
  stamp: string;
  updatedAt: string;
  /** Normalized text of every segment joined by one newline. */
  haystack: string;
  segments: SearchSegment[];
  chars: number;
  /** True when messages were dropped by the message or character budget. */
  truncated: boolean;
}

interface DraftSegment {
  kind: SearchSegmentKind;
  messageId: string | null;
  role: RuntimeMessageRole | null;
  createdAt: string | null;
  text: string;
}

/**
 * Case, width and whitespace fold to one form so a query matches the same text
 * the user sees, without storing a second copy for every normalization.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The projection only exposes `updatedAt`; a rewritten transcript always moves
 * it, so it is the cheapest usable fingerprint for an incrementally built index.
 */
export function sessionStamp(session: AgentSession): string {
  return `${session.updatedAt}|${session.title ?? ''}|${session.prompt ?? ''}`;
}

function titleAndPromptDrafts(session: AgentSession): {
  drafts: DraftSegment[];
  truncated: boolean;
} {
  const drafts: DraftSegment[] = [];
  let truncated = false;
  for (const [kind, value, limit] of [
    ['title', session.title ?? '', MAX_INDEXED_TITLE_CHARS],
    ['prompt', session.prompt ?? '', MAX_INDEXED_PROMPT_CHARS],
  ] as const) {
    const raw = normalizeSearchText(value);
    const text = raw.slice(0, limit);
    if (text.length < raw.length) truncated = true;
    if (!text) continue;
    drafts.push({
      kind,
      messageId: null,
      role: null,
      createdAt: null,
      text,
    });
  }
  return { drafts, truncated };
}

function assemble(
  head: Pick<SessionSearchDocument, 'sessionId' | 'stamp' | 'updatedAt'>,
  drafts: readonly DraftSegment[],
  truncated: boolean,
): SessionSearchDocument {
  const segments: SearchSegment[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const draft of drafts) {
    const prefix = parts.length ? '\n' : '';
    parts.push(prefix, draft.text);
    offset += prefix.length;
    segments.push({
      kind: draft.kind,
      messageId: draft.messageId,
      role: draft.role,
      createdAt: draft.createdAt,
      start: offset,
      end: offset + draft.text.length,
    });
    offset += draft.text.length;
  }
  return {
    ...head,
    haystack: parts.join(''),
    segments,
    chars: offset,
    truncated,
  };
}

/** Title and prompt only: what the session list already has in memory. */
export function buildProjectionDocument(
  session: AgentSession,
): SessionSearchDocument {
  const { drafts, truncated } = titleAndPromptDrafts(session);
  return assemble(
    {
      sessionId: session.id,
      stamp: sessionStamp(session),
      updatedAt: session.updatedAt,
    },
    drafts,
    truncated,
  );
}

/**
 * Builds from the messages the caller could read. Only the newest messages that
 * fit the budget are kept; `truncated` tells the caller older text is unindexed.
 */
export function buildSessionSearchDocument(
  session: AgentSession,
  messages: readonly AgentRuntimeMessage[],
): SessionSearchDocument {
  const ordered = messages
    .filter((message) => SEARCHED_ROLES.has(message.role))
    .slice()
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );

  const head = titleAndPromptDrafts(session);
  const selected: DraftSegment[] = [];
  let chars = head.drafts.reduce(
    (total, draft) => total + draft.text.length,
    0,
  );
  let truncated = head.truncated;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index];
    const raw = normalizeSearchText(messageText(message));
    if (!raw) continue;
    const text =
      raw.length > MAX_INDEXED_MESSAGE_CHARS
        ? raw.slice(0, MAX_INDEXED_MESSAGE_CHARS)
        : raw;
    if (text.length < raw.length) truncated = true;
    if (
      selected.length >= MAX_INDEXED_MESSAGES ||
      chars + text.length > MAX_INDEXED_SESSION_CHARS
    ) {
      truncated = true;
      break;
    }
    selected.push({
      kind: 'message',
      messageId: message.id,
      role: message.role,
      createdAt: message.createdAt,
      text,
    });
    chars += text.length;
  }
  selected.reverse();
  return assemble(
    {
      sessionId: session.id,
      stamp: sessionStamp(session),
      updatedAt: session.updatedAt,
    },
    [...head.drafts, ...selected],
    truncated,
  );
}

/** Drops message text while keeping title and prompt searchable. */
export function compactDocument(
  document: SessionSearchDocument,
): SessionSearchDocument {
  const drafts = document.segments
    .filter((segment) => segment.kind !== 'message')
    .map((segment) => ({
      kind: segment.kind,
      messageId: segment.messageId,
      role: segment.role,
      createdAt: segment.createdAt,
      text: document.haystack.slice(segment.start, segment.end),
    }));
  return assemble(
    {
      sessionId: document.sessionId,
      stamp: document.stamp,
      updatedAt: document.updatedAt,
    },
    drafts,
    true,
  );
}

/** Binary search for the segment containing an absolute haystack offset. */
export function segmentAt(
  document: SessionSearchDocument,
  offset: number,
): SearchSegment | undefined {
  const segments = document.segments;
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = segments[middle];
    if (offset < candidate.start) high = middle - 1;
    else if (offset >= candidate.end) low = middle + 1;
    else return candidate;
  }
  return undefined;
}

/** Stored shape: positional arrays keep the on-disk document compact. */
export type StoredSegment = [
  kind: SearchSegmentKind,
  messageId: string | null,
  role: RuntimeMessageRole | null,
  createdAt: string | null,
  text: string,
];

export interface StoredDocument {
  id: string;
  stamp: string;
  updatedAt: string;
  truncated: boolean;
  segments: StoredSegment[];
}

export function encodeDocument(document: SessionSearchDocument): StoredDocument {
  return {
    id: document.sessionId,
    stamp: document.stamp,
    updatedAt: document.updatedAt,
    truncated: document.truncated,
    segments: document.segments.map((segment) => [
      segment.kind,
      segment.messageId,
      segment.role,
      segment.createdAt,
      document.haystack.slice(segment.start, segment.end),
    ]),
  };
}

const SEGMENT_KINDS: ReadonlySet<string> = new Set([
  'title',
  'prompt',
  'message',
]);
const SEGMENT_ROLES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'system',
  'tool',
]);
const MAX_STORED_SEGMENT_CHARS =
  MAX_INDEXED_MESSAGE_CHARS + MAX_INDEXED_SESSION_CHARS;

/** Rejects a damaged cache entry instead of indexing text the reader never saw. */
export function decodeDocument(
  stored: StoredDocument | undefined,
): SessionSearchDocument | null {
  if (
    !stored ||
    typeof stored.id !== 'string' ||
    typeof stored.stamp !== 'string' ||
    typeof stored.updatedAt !== 'string' ||
    !Array.isArray(stored.segments)
  )
    return null;
  const drafts: DraftSegment[] = [];
  for (const entry of stored.segments) {
    if (!Array.isArray(entry) || entry.length !== 5) return null;
    const [kind, messageId, role, createdAt, text] = entry;
    if (!SEGMENT_KINDS.has(kind) || typeof text !== 'string') return null;
    if (text.length > MAX_STORED_SEGMENT_CHARS) return null;
    drafts.push({
      kind: kind as SearchSegmentKind,
      messageId: typeof messageId === 'string' ? messageId : null,
      role:
        typeof role === 'string' && SEGMENT_ROLES.has(role)
          ? (role as RuntimeMessageRole)
          : null,
      createdAt: typeof createdAt === 'string' ? createdAt : null,
      text,
    });
  }
  const document = assemble(
    {
      sessionId: stored.id,
      stamp: stored.stamp,
      updatedAt: stored.updatedAt,
    },
    drafts,
    stored.truncated === true,
  );
  return document;
}
