import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import * as z from 'zod/v4';
import {
  agentContextBuilder,
  agentEventService,
  agentLoopRuntime,
  agentRuntimeStore,
  agentSessionRuntime,
  buildContextRequestSchema,
  clearInactiveSessionsBodySchema,
  createSessionRequestSchema,
  listEventsQuerySchema,
  listSessionsQuerySchema,
  listSkillsQuerySchema,
  permissionPolicy,
  permissionReplyRequestSchema,
  profileService,
  resolveSessionCapabilities,
  skillRegistry,
  streamTurnRequestSchema,
  toHttpError,
} from '../services/agent-runtime/index.js';
import {
  interruptAgentSessionsAndWait,
  resumeAgentSessionInBackground,
  streamAgentSession,
} from '../services/agent-runtime/agent-stream-proxy.js';
import { runtimeBus } from '../services/agent-runtime/runtime-bus.js';
import { sessionLiveBus } from '../services/agent-runtime/session-live-bus.js';
import { logger } from '../lib/logger.js';
import { SseEventType } from '../lib/sse-events.js';
import { assertLlmProviderConfigured } from '../services/llm-runtime/provider-check.js';

export const agentRuntimeRoutes = new Hono();
const AGENT_RUNTIME_HEARTBEAT_MS = 10_000;

function isHealthyAgentRuntimeSession(session: ReturnType<typeof agentSessionRuntime.get>): boolean {
  if (session.status === 'cancelled' || session.status === 'failed') return false;
  if (session.status === 'running' || session.status === 'waiting_permission') {
    return session.activeRunId !== null;
  }
  return true;
}

async function readJson(c: Context) {
  try {
    return { ok: true as const, data: await c.req.json() };
  } catch {
    return { ok: false as const, error: 'Invalid JSON body' };
  }
}

function validationError(c: Context, error: z.ZodError) {
  return c.json({ error: 'Validation failed', details: error.flatten() }, 400);
}

function runtimeError(c: Context, error: unknown) {
  const mapped = toHttpError(error);
  return c.json(mapped.body, mapped.status as 400 | 401 | 403 | 404 | 409 | 500);
}

function withSessionPayload(sessionId: string) {
  const session = agentSessionRuntime.get(sessionId);
  const profile = profileService.get(session.profileId);
  return {
    session,
    profile,
    context: session.contextSnapshotId ? agentRuntimeStore.getContextBundle(session.contextSnapshotId) : null,
    candidateSkills: skillRegistry.listSummaries({ profileId: profile.id }),
  };
}

agentRuntimeRoutes.get('/profiles', (c) => c.json({ items: profileService.list() }));

agentRuntimeRoutes.get('/skills', (c) => {
  const parsed = listSkillsQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return validationError(c, parsed.error);
  return c.json({ items: skillRegistry.listSummaries({ profileId: parsed.data.profileId }) });
});

agentRuntimeRoutes.post('/contexts/:projectId', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = buildContextRequestSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    return c.json(agentContextBuilder.build(c.req.param('projectId'), parsed.data), 201);
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post('/sessions', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = createSessionRequestSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    assertLlmProviderConfigured(parsed.data.projectId);
    const session = agentSessionRuntime.create(parsed.data);
    return c.json(withSessionPayload(session.id), 201);
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get('/sessions', (c) => {
  const parsed = listSessionsQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return validationError(c, parsed.error);
  const { limit, offset, ...filter } = parsed.data;
  const allFiltered = agentSessionRuntime.list({ ...filter, limit: Number.MAX_SAFE_INTEGER });
  const countByStatus: Record<string, number> = {};
  for (const s of allFiltered) {
    countByStatus[s.status] = (countByStatus[s.status] || 0) + 1;
  }
  const totalCount = allFiltered.length;
  const items = allFiltered.slice(offset, offset + limit);
  return c.json({ items, totalCount, countByStatus });
});

agentRuntimeRoutes.get('/sessions/:sessionId', (c) => {
  try {
    return c.json(withSessionPayload(c.req.param('sessionId')));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post('/sessions/:sessionId/cancel', (c) => {
  try {
    return c.json(agentSessionRuntime.cancel(c.req.param('sessionId')));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post('/sessions/:sessionId/pause', (c) => {
  try {
    return c.json(agentSessionRuntime.pause(c.req.param('sessionId')));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.delete('/sessions/:sessionId', async (c) => {
  try {
    const sessionIds = agentSessionRuntime.listSessionTree(c.req.param('sessionId')).map((session) => session.id);
    await interruptAgentSessionsAndWait(sessionIds);
    return c.json({
      ok: true,
      deletedSessionIds: agentSessionRuntime.delete(c.req.param('sessionId')),
    });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post('/sessions/clear-inactive', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = clearInactiveSessionsBodySchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const { projectId } = parsed.data;
    const keep = new Set(['running', 'waiting_permission', 'paused', 'queued']);

    const allSessions = agentSessionRuntime.list({ projectId, limit: Number.MAX_SAFE_INTEGER });
    const toDelete = allSessions.filter(
      (s) => !keep.has(s.status),
    );

    const toDeleteIds = new Set(toDelete.map((s) => s.id));
    // Only delete roots (sessions whose parent is not also being deleted)
    const roots = toDelete.filter(
      (s) => !s.parentSessionId || !toDeleteIds.has(s.parentSessionId),
    );

    const deletedIds: string[] = [];
    for (const root of roots) {
      const treeIds = agentSessionRuntime.listSessionTree(root.id).map((s) => s.id);
      await agentLoopRuntime.interruptAndWaitForSessions(treeIds);
      deletedIds.push(...agentSessionRuntime.delete(root.id));
    }

    return c.json({ ok: true, deletedCount: toDelete.length, deletedSessionIds: deletedIds });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get('/sessions/:sessionId/messages', (c) => {
  try {
    return c.json({ items: agentLoopRuntime.listMessages(c.req.param('sessionId')) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get('/sessions/:sessionId/runs', (c) => {
  try {
    return c.json({ items: agentLoopRuntime.listRuns(c.req.param('sessionId')) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get('/sessions/:sessionId/runs/:runId', (c) => {
  try {
    return c.json(agentLoopRuntime.getRun(c.req.param('sessionId'), c.req.param('runId')));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get('/sessions/:sessionId/runs/:runId/steps', (c) => {
  try {
    return c.json({ items: agentLoopRuntime.listRunSteps(c.req.param('sessionId'), c.req.param('runId')) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get('/sessions/:sessionId/steps', (c) => {
  try {
    return c.json({ items: agentRuntimeStore.listSessionSteps(c.req.param('sessionId')) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post('/sessions/:sessionId/turns/stream', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = streamTurnRequestSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  const sessionId = c.req.param('sessionId');
  let session: ReturnType<typeof agentSessionRuntime.get>;
  try {
    session = agentSessionRuntime.get(sessionId);
  } catch (error) {
    return runtimeError(c, error);
  }
  try {
    assertLlmProviderConfigured(session.projectId);
  } catch (error) {
    return runtimeError(c, error);
  }

  const abortController = new AbortController();
  const abortWithReason = (reason: string) => {
    if (!abortController.signal.aborted) {
      abortController.abort(new Error(reason));
    }
  };

  if (c.req.raw.signal.aborted) {
    abortWithReason('Client disconnected before the agent runtime stream started.');
  } else {
    c.req.raw.signal.addEventListener(
      'abort',
      () => {
        abortWithReason('Client disconnected.');
      },
      { once: true },
    );
  }

  return streamSSE(c, async (stream) => {
    const heartbeat = setInterval(() => {
      if (abortController.signal.aborted) return;

      let session: ReturnType<typeof agentSessionRuntime.get>;
      try {
        session = agentSessionRuntime.get(sessionId);
      } catch (error) {
        logger.warn(
          {
            sessionId,
            err: error instanceof Error ? error.message : String(error),
          },
          '[agent-runtime] session health check failed',
        );
        abortWithReason('Agent runtime session is unavailable.');
        return;
      }

      if (!isHealthyAgentRuntimeSession(session)) {
        logger.warn(
          {
            sessionId,
            status: session.status,
            activeRunId: session.activeRunId,
          },
          '[agent-runtime] session health check failed',
        );
        abortWithReason(`Agent runtime session became unhealthy (${session.status}).`);
        return;
      }

      void stream
        .writeSSE({
          event: SseEventType.Ping,
          data: JSON.stringify({
            type: SseEventType.Ping,
            sessionId,
            timestamp: Date.now(),
          }),
        })
        .catch((error) => {
          logger.warn(
            {
              sessionId,
              err: error instanceof Error ? error.message : String(error),
            },
            '[agent-runtime] heartbeat write failed',
          );
          abortWithReason('Agent runtime heartbeat failed.');
        });
    }, AGENT_RUNTIME_HEARTBEAT_MS);

    stream.onAbort(() => {
      clearInterval(heartbeat);
      agentEventService.append({
        sessionId,
        type: 'progress_updated',
        summary: 'Runtime turn stream aborted by client.',
        payload: { aborted: true },
        visibility: 'internal',
      });
      abortWithReason('Client disconnected.');
    });

    try {
      for await (const chunk of streamAgentSession(sessionId, 'turn', parsed.data, abortController.signal)) {
        await stream.writeSSE({ data: JSON.stringify(chunk) });
      }
    } finally {
      clearInterval(heartbeat);
    }
    if (!abortController.signal.aborted) {
      await stream.writeSSE({ data: '[DONE]' });
    }
  });
});

agentRuntimeRoutes.get('/sessions/:sessionId/events', (c) => {
  const parsed = listEventsQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    return c.json({ items: agentEventService.list(c.req.param('sessionId'), parsed.data.after) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post('/sessions/:sessionId/resume/stream', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = streamTurnRequestSchema.safeParse(body.data ?? {});
  if (!parsed.success) return validationError(c, parsed.error);
  const sessionId = c.req.param('sessionId');
  let session: ReturnType<typeof agentSessionRuntime.get>;
  try {
    session = agentSessionRuntime.get(sessionId);
  } catch (error) {
    return runtimeError(c, error);
  }
  try {
    assertLlmProviderConfigured(session.projectId);
  } catch (error) {
    return runtimeError(c, error);
  }

  const abortController = new AbortController();
  const abortWithReason = (reason: string) => {
    if (!abortController.signal.aborted) {
      abortController.abort(new Error(reason));
    }
  };

  if (c.req.raw.signal.aborted) {
    abortWithReason('Client disconnected before the agent runtime stream started.');
  } else {
    c.req.raw.signal.addEventListener('abort', () => abortWithReason('Client disconnected.'), { once: true });
  }

  return streamSSE(c, async (stream) => {
    const heartbeat = setInterval(() => {
      if (abortController.signal.aborted) return;
      stream.writeSSE({ data: JSON.stringify({ type: 'heartbeat', sessionId, timestamp: Date.now() }) })
        .catch((error) => {
          logger.warn({ sessionId, err: error instanceof Error ? error.message : String(error) }, '[agent-runtime] resume heartbeat write failed');
          abortWithReason('Agent runtime heartbeat failed.');
        });
    }, AGENT_RUNTIME_HEARTBEAT_MS);

    stream.onAbort(() => {
      clearInterval(heartbeat);
      abortWithReason('Client disconnected.');
    });

    try {
      for await (const chunk of streamAgentSession(sessionId, 'continue', parsed.data, abortController.signal)) {
        await stream.writeSSE({ data: JSON.stringify(chunk) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ sessionId, err: message }, '[agent-runtime] resume stream error');
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', error: message }) });
    } finally {
      clearInterval(heartbeat);
    }
    if (!abortController.signal.aborted) {
      await stream.writeSSE({ data: '[DONE]' });
    }
  });
});

agentRuntimeRoutes.get('/sessions/:sessionId/artifacts', (c) => {
  try {
    agentSessionRuntime.get(c.req.param('sessionId'));
    return c.json({ items: agentRuntimeStore.listArtifacts(c.req.param('sessionId')) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get('/sessions/:sessionId/tool-calls', (c) => {
  try {
    agentSessionRuntime.get(c.req.param('sessionId'));
    return c.json({ items: agentRuntimeStore.listToolCalls(c.req.param('sessionId')) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get('/sessions/:sessionId/stats', (c) => {
  try {
    const stats = agentRuntimeStore.getSessionStats(c.req.param('sessionId'));
    return c.json(stats);
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get('/sessions/:sessionId/capabilities', (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    agentSessionRuntime.get(sessionId);
    return c.json(resolveSessionCapabilities(sessionId));
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get('/sessions/:sessionId/todos', (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    agentSessionRuntime.get(sessionId);
    const events = agentRuntimeStore.listEvents(sessionId);
    let items: Array<{ id: string; label: string; status: string }> = [];
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'task_state_updated') {
        const tasks = (events[i].payload.tasks as Array<{ id: string; subject: string; status: string }>) ?? [];
        items = tasks
          .filter(t => t.status !== 'deleted')
          .map(t => ({
            id: t.id,
            label: t.subject,
            status: t.status === 'completed' ? 'done' : t.status,
          }));
        break;
      }
    }
    return c.json({ items });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.get('/sessions/:sessionId/permissions', (c) => {
  try {
    agentSessionRuntime.get(c.req.param('sessionId'));
    return c.json({ items: permissionPolicy.list(c.req.param('sessionId')) });
  } catch (error) {
    return runtimeError(c, error);
  }
});

agentRuntimeRoutes.post('/sessions/:sessionId/permissions/:permissionId/reply', async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const parsed = permissionReplyRequestSchema.safeParse(body.data);
  if (!parsed.success) return validationError(c, parsed.error);
  const sessionId = c.req.param('sessionId');
  try {
    const decision = permissionPolicy.reply(
      sessionId,
      c.req.param('permissionId'),
      parsed.data.reply,
      parsed.data.message,
    );
    logger.info(
      {
        sessionId,
        permissionId: decision.id,
        reply: parsed.data.reply,
        action: decision.action,
        resumeToken: decision.resumeToken,
      },
      '[agent-runtime] permission reply received',
    );
    agentEventService.append({
      sessionId,
      type: 'permission_resolved',
      summary: decision.reason,
      payload: { permissionId: decision.id, action: decision.action, userReply: decision.userReply },
    });
    agentRuntimeStore.updateSession(sessionId, {
      status: decision.resumeToken ? 'running' : decision.action === 'allow' ? 'running' : 'blocked',
      updatedAt: new Date().toISOString(),
      pendingResumeToken: decision.resumeToken,
      blockedReason: null,
      resultSummary: null,
    });
    if (decision.resumeToken) {
      logger.info(
        {
          sessionId,
          permissionId: decision.id,
          resumeToken: decision.resumeToken,
        },
        '[agent-runtime] scheduling run resume after permission reply',
      );
      resumeAgentSessionInBackground(sessionId, parsed.data.message ? { message: parsed.data.message } : {});
    }
    return c.json(decision);
  } catch (error) {
    return runtimeError(c, error);
  }
});

// ============================== SSE 事件流 ==============================

agentRuntimeRoutes.get('/events/stream', (c) => {
  return streamSSE(c, async (stream) => {
    let closed = false;

    const onEvent = (event: { type: string; sessionId: string; patch?: Record<string, unknown> }) => {
      if (closed) return;
      stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
        .catch(() => { closed = true; });
    };

    const unsubscribe = runtimeBus.subscribe(onEvent);

    await stream.writeSSE({ event: SseEventType.Connected, data: '{}' });

    const heartbeat = setInterval(() => {
      if (closed) return;
      stream.writeSSE({ event: SseEventType.Ping, data: String(Date.now()) })
        .catch(() => { closed = true; });
    }, 25_000);

    c.req.raw.signal.addEventListener('abort', () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    clearInterval(heartbeat);
    unsubscribe();
  });
});

agentRuntimeRoutes.get('/sessions/:sessionId/live', (c) => {
  const sessionId = c.req.param('sessionId');
  try {
    agentSessionRuntime.get(sessionId);
  } catch (error) {
    return runtimeError(c, error);
  }
  return streamSSE(c, async (stream) => {
    let closed = false;

    const onEvent = (event: { type: string; stepId: string }) => {
      if (closed) return;
      stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
        .catch(() => { closed = true; });
    };

    const unsubscribe = sessionLiveBus.subscribe(sessionId, onEvent);

    await stream.writeSSE({ event: SseEventType.Connected, data: '{}' });

    const heartbeat = setInterval(() => {
      if (closed) return;
      stream.writeSSE({ event: SseEventType.Ping, data: String(Date.now()) })
        .catch(() => { closed = true; });
    }, 25_000);

    c.req.raw.signal.addEventListener('abort', () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    clearInterval(heartbeat);
    unsubscribe();
  });
});
