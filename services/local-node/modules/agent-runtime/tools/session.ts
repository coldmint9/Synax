import type { RegisteredTool, ToolExecutionResult } from '../contracts.js';
import {
  createRuntimeSessionReader,
  SessionQueryError,
  SessionQueryService,
  sessionListQuerySchema,
  sessionSearchQuerySchema,
  sessionStatusQuerySchema,
} from '../session-query/index.js';

function failure(error: SessionQueryError): ToolExecutionResult {
  return {
    outcome: 'failed',
    result: { code: error.code, error: error.message },
    displaySummary: error.message,
    artifacts: [],
  };
}

export function createSessionListTool(
  service: Pick<SessionQueryService, 'list'>,
): RegisteredTool {
  return {
    id: 'session.list',
    label: 'List conversations',
    category: 'read',
    internalGate: 'none',
    mutability: 'read',
    resumeBehavior: 'auto',
    description:
      'List conversations in the current workspace (or every workspace with scope all): id, title, runtime status, timestamps and a prompt preview. Read-only and newest first. Subagent and side-chat sessions are hidden unless includeChildren; archived sessions require includeArchived.',
    progressiveDetails:
      'Use the returned id with session.status for one conversation, or session.search for transcript text. Paginate with offset; countByStatus covers the whole filtered set, not only this page. Pinned sessions lead the order. scope all needs no projectId and is rejected together with one.',
    inputSchema: sessionListQuerySchema,
    async execute(input) {
      const args = sessionListQuerySchema.parse(input.args ?? {});
      try {
        const result = await service.list(args, input.sessionId);
        return {
          result,
          displaySummary: `会话 ${result.items.length}/${result.totalCount}${result.hasMore ? ' · 还有更多' : ''}`,
          artifacts: [],
        };
      } catch (error) {
        if (!(error instanceof SessionQueryError)) throw error;
        return failure(error);
      }
    },
  };
}

export function createSessionStatusTool(
  service: Pick<SessionQueryService, 'status'>,
): RegisteredTool {
  return {
    id: 'session.status',
    label: 'Read conversation status',
    category: 'read',
    internalGate: 'none',
    mutability: 'read',
    resumeBehavior: 'auto',
    description:
      'Report runtime state for one or more sessions: status, active run, waiting or blocked reason, pending resume token, recovery flag, run/step/tool totals and direct child sessions. Defaults to the current session.',
    progressiveDetails:
      'Statuses follow the UI projection: queued, running, stopping, waiting_permission, waiting_input, paused, completed, failed, cancelled, interrupted. Unknown ids are returned in missing; when every id is unknown the call fails with SESSION_NOT_FOUND. Analytics come from the persisted session projection and never read a transcript.',
    inputSchema: sessionStatusQuerySchema,
    async execute(input) {
      const args = sessionStatusQuerySchema.parse(input.args ?? {});
      try {
        const result = await service.status(args, input.sessionId);
        return {
          result,
          displaySummary: `会话状态 ${result.items.length}${result.missing.length ? ` · 缺失 ${result.missing.length}` : ''}`,
          artifacts: [],
        };
      } catch (error) {
        if (!(error instanceof SessionQueryError)) throw error;
        return failure(error);
      }
    },
  };
}

export function createSessionSearchTool(
  service: Pick<SessionQueryService, 'search'>,
): RegisteredTool {
  return {
    id: 'session.search',
    label: 'Search conversations',
    category: 'read',
    internalGate: 'none',
    mutability: 'read',
    resumeBehavior: 'auto',
    description:
      'Search session titles, first prompts and message text across conversations. Case-insensitive literal match; returns session id, message id, role, snippet and match count so a later read can cite the exact record.',
    progressiveDetails:
      'Defaults to the current workspace, root sessions, user and assistant messages, the newest 20 transcripts and 20 hits. Transcript reads are the expensive part: lower maxSessions or pass sessionIds to bound them. truncated means older transcripts or extra hits were not returned. Title and prompt hits are reported without reading a transcript.',
    inputSchema: sessionSearchQuerySchema,
    async execute(input) {
      const args = sessionSearchQuerySchema.parse(input.args ?? {});
      try {
        const result = await service.search(args, input.sessionId);
        return {
          result,
          displaySummary: `检索 ${result.items.length}${result.truncated ? ' · 已截断' : ''} · 扫描 ${result.scannedSessions}/${result.candidateSessions}`,
          artifacts: [],
        };
      } catch (error) {
        if (!(error instanceof SessionQueryError)) throw error;
        return failure(error);
      }
    },
  };
}

const sessionQueryService = new SessionQueryService(
  createRuntimeSessionReader(),
);

export const sessionTools: RegisteredTool[] = [
  createSessionListTool(sessionQueryService),
  createSessionStatusTool(sessionQueryService),
  createSessionSearchTool(sessionQueryService),
];
