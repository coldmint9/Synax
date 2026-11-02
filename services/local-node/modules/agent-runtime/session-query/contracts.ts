import { z } from 'zod/v4';
import {
  sessionStatusSchema,
  type AgentRuntimeMessage,
  type AgentSession,
  type AgentSessionStatus,
  type RuntimeMessageRole,
} from '../contracts.js';

const sessionIdSchema = z.string().trim().min(1).max(256);
const projectIdSchema = z.string().trim().min(1).max(128);
const scopeSchema = z
  .enum(['project', 'all'])
  .describe(
    'project: the current workspace (default). all: every workspace in this installation.',
  );

export const sessionMessageRoleSchema = z.enum([
  'user',
  'assistant',
  'system',
  'tool',
]);
export type SessionMessageRole = z.infer<typeof sessionMessageRoleSchema>;

const PAGE_LIMIT_MAX = 100;

export const sessionListQuerySchema = z
  .object({
    scope: scopeSchema.default('project'),
    projectId: projectIdSchema
      .optional()
      .describe(
        'Workspace to list when scope is project. Defaults to the current session workspace; rejected with scope all.',
      ),
    status: z
      .array(sessionStatusSchema)
      .min(1)
      .max(10)
      .optional()
      .describe('Only return sessions in these runtime states.'),
    includeChildren: z
      .boolean()
      .default(false)
      .describe(
        'Include subagent and side-chat sessions. Default lists root conversations only.',
      ),
    includeArchived: z
      .boolean()
      .default(false)
      .describe('Include archived sessions. Deleted sessions are never listed.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(PAGE_LIMIT_MAX)
      .default(20)
      .describe('Page size. Pinned sessions come first, then newest updatedAt.'),
    offset: z.number().int().min(0).max(100_000).default(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === 'all' && value.projectId)
      ctx.addIssue({
        code: 'custom',
        path: ['projectId'],
        message: 'projectId applies only to project scope.',
      });
  });

export const sessionStatusQuerySchema = z
  .object({
    sessionIds: z
      .array(sessionIdSchema)
      .min(1)
      .max(20)
      .optional()
      .describe(
        'Sessions to inspect. Omit to inspect the current session. Duplicate ids are collapsed.',
      ),
    includeChildren: z
      .boolean()
      .default(false)
      .describe('Also report direct subagent and side-chat children.'),
  })
  .strict();

export const sessionSearchQuerySchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .describe(
        'Case-insensitive literal text to find in session titles, first prompts and message content.',
      ),
    scope: scopeSchema.default('project'),
    projectId: projectIdSchema
      .optional()
      .describe(
        'Workspace to search when scope is project. Defaults to the current session workspace; rejected with scope all or sessionIds.',
      ),
    sessionIds: z
      .array(sessionIdSchema)
      .min(1)
      .max(20)
      .optional()
      .describe(
        'Restrict the search to these sessions. Overrides scope; duplicate ids are collapsed.',
      ),
    roles: z
      .array(sessionMessageRoleSchema)
      .min(1)
      .max(4)
      .default(['user', 'assistant'])
      .describe('Message roles to scan. Defaults to user and assistant.'),
    includeTitleMatches: z
      .boolean()
      .default(true)
      .describe(
        'Also return title and first-prompt matches, which need no transcript read.',
      ),
    includeChildren: z
      .boolean()
      .default(false)
      .describe('Scan subagent and side-chat transcripts too.'),
    includeArchived: z
      .boolean()
      .default(false)
      .describe('Include archived sessions. Deleted sessions are never searched.'),
    maxSessions: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe(
        'Read at most this many transcripts, newest first. Title matches are still checked within the same bound.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('Maximum hits returned across sessions.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const error = (message: string, path: string[]) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (value.scope === 'all' && value.projectId)
      error('projectId applies only to project scope.', ['projectId']);
    if (value.sessionIds?.length && value.projectId)
      error('sessionIds cannot be combined with projectId.', ['projectId']);
    if (value.sessionIds?.length && value.scope === 'all')
      error('sessionIds cannot be combined with scope all.', ['scope']);
  });

export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;
export type SessionStatusQuery = z.infer<typeof sessionStatusQuerySchema>;
export type SessionSearchQuery = z.infer<typeof sessionSearchQuerySchema>;
export type SessionQueryScope = z.infer<typeof scopeSchema>;

/** Read-only view of authoritative runtime history. Adapters may be stubbed in tests. */
export interface SessionReader {
  listSessions(): Promise<AgentSession[]>;
  getSession(sessionId: string): Promise<AgentSession>;
  listMessages(sessionId: string): Promise<AgentRuntimeMessage[]>;
}

export interface SessionListItem {
  id: string;
  title: string | null;
  projectId: string;
  profileId: string;
  status: AgentSessionStatus;
  parentSessionId: string | null;
  nodeId: string | null;
  pinned: boolean;
  archived: boolean;
  activeRunId: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  promptPreview: string;
}

export interface SessionListResult {
  scope: SessionQueryScope;
  projectId: string | null;
  items: SessionListItem[];
  totalCount: number;
  hasMore: boolean;
  nextOffset: number | null;
  countByStatus: Record<string, number>;
}

export interface SessionAnalyticsSummary {
  steps: number;
  completedRuns: number;
  completedRunSteps: number;
  toolCalls: number;
  lastStepId: string | null;
  lastCompletedRunId: string | null;
  updatedAt: string;
}

export interface SessionChildStatus {
  id: string;
  title: string | null;
  status: AgentSessionStatus;
  activeRunId: string | null;
}

export interface SessionStatusItem {
  id: string;
  title: string | null;
  projectId: string;
  profileId: string;
  status: AgentSessionStatus;
  parentSessionId: string | null;
  activeRunId: string | null;
  blockedReason: string | null;
  pendingResumeToken: string | null;
  resultSummary: string | null;
  runtimeRecoveryRequired: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  analytics: SessionAnalyticsSummary | null;
  children: SessionChildStatus[];
}

export interface SessionStatusResult {
  items: SessionStatusItem[];
  missing: string[];
}

export type SessionSearchHitKind = 'title' | 'prompt' | 'message';

export interface SessionSearchHit {
  sessionId: string;
  title: string | null;
  status: AgentSessionStatus;
  sessionUpdatedAt: string;
  kind: SessionSearchHitKind;
  messageId: string | null;
  role: RuntimeMessageRole | null;
  createdAt: string | null;
  snippet: string;
  matchCount: number;
}

export interface SessionSearchResult {
  query: string;
  /** `sessions` when the caller restricted the scan with explicit sessionIds. */
  scope: SessionQueryScope | 'sessions';
  projectId: string | null;
  candidateSessions: number;
  scannedSessions: number;
  truncated: boolean;
  items: SessionSearchHit[];
  /** Explicitly requested session ids that no longer exist. */
  missing: string[];
}
