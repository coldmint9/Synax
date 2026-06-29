import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import * as z from 'zod/v4';
import { createAcpClientForProject } from '../services/acp/index.js';
import type { DispatchIntentInput } from '../services/acp/contracts.js';
import {
  spawnAcpConnection,
  initializeSession,
  resolveSpawnForProvider,
  resolveSpawnForProviderAsync,
} from '../services/acp/protocol/acp-connection.js';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { getEffectiveConfig } from '../lib/config/config-store.js';
import { logger } from '../lib/logger.js';

export const acpRoutes = new Hono();

// --- _internal: ACP text-generation bridge for local agent runtime calls ---

const acpGenerateSchema = z.object({
  projectId: z.string().optional(),
  providerId: z.enum(['opencode-acp', 'cursor-acp']).optional(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  })),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  workDir: z.string().optional(),
});

const ACP_GENERATE_TIMEOUT_MS = 30 * 60_000;

acpRoutes.post('/_internal/acp-generate', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = acpGenerateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const { messages, projectId, workDir } = parsed.data;
  const configuredProviderId = projectId ? getEffectiveConfig(projectId).providerId : null;
  const providerId = parsed.data.providerId
    ?? (configuredProviderId === 'cursor-acp' || configuredProviderId === 'opencode-acp'
      ? configuredProviderId
      : 'opencode-acp');

  const promptText = messages
    .map((m) => (m.role === 'system' ? `[System] ${m.content}` : m.content))
    .join('\n\n');

  logger.info(
    { providerId, promptLength: promptText.length, messageCount: messages.length, workDir: workDir ?? null },
    '[acp-generate] request received',
  );

  return streamSSE(c, async (stream) => {
    let acpConn: ReturnType<typeof spawnAcpConnection> | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    stream.onAbort(() => {
      logger.info('[acp-generate] client aborted');
      acpConn?.cleanup();
    });

    try {
      const spawnSpec = await resolveSpawnForProviderAsync(providerId);
      acpConn = spawnAcpConnection({
        async sessionUpdate(params: SessionNotification) {
          const update = params.update;
          if (update.sessionUpdate === 'agent_message_chunk') {
            const content = update.content;
            let text = '';
            if (content && typeof content === 'object' && 'type' in content) {
              if (content.type === 'text' && 'text' in content) {
                text = (content as { text: string }).text;
              }
            }
            if (text) {
              await stream.writeSSE({ data: JSON.stringify({ delta: text }) });
            }
          }
        },
      }, spawnSpec);

      const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
        acpConn!.child.once('error', (err) => reject(err));
        acpConn!.child.once('exit', (code, signal) => {
          if (code !== 0 && code !== null) {
            reject(
              new Error(
                `${acpConn!.spawn.commandLabel} exited with code ${code}${signal ? ` (signal=${signal})` : ''}`,
              ),
            );
          }
        });
      });

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('ACP generate timed out')),
          ACP_GENERATE_TIMEOUT_MS,
        );
      });

      const protocolFlow = async (): Promise<void> => {
        const session = await initializeSession(acpConn!.conn, workDir);
        const sessionId = session.sessionId;
        await acpConn!.conn.prompt({
          sessionId,
          prompt: [{ type: 'text', text: promptText }],
        });
      };

      await Promise.race([protocolFlow(), timeoutPromise, spawnErrorPromise]);

      await stream.writeSSE({ data: '[DONE]' });
      logger.info('[acp-generate] completed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stderr = acpConn?.stderrChunks.join('') ?? '';
      logger.error({ err: message, stderr }, '[acp-generate] failed');
      await stream.writeSSE({ data: JSON.stringify({ error: message }) });
      await stream.writeSSE({ data: '[DONE]' });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      acpConn?.cleanup();
    }
  });
});

// --- Dispatch routes ---

const dispatchSchema = z.object({
  projectId: z.string(),
  sessionId: z.string().nullable().optional(),
  userId: z.string(),
  userName: z.string(),
  intent: z.string().min(1),
  providerId: z.enum(['opencode-acp', 'cursor-acp']),
  context: z.object({
    selectedNodeId: z.string().nullable().optional(),
    selectedClusterId: z.string().nullable().optional(),
    workDir: z.string().nullable().optional(),
    contextSnapshotId: z.string().nullable().optional(),
    contextPrompt: z.string().nullable().optional(),
  }).optional(),
});

acpRoutes.post('/dispatch/stream', async (c) => {
  logger.info({ path: '/dispatch/stream' }, 'Stream dispatch request received');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = dispatchSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.flatten() }, 'Stream dispatch validation failed');
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const input: DispatchIntentInput = parsed.data;
  logger.info({ projectId: input.projectId, intent: input.intent }, 'Stream dispatch starting');

  const acpClient = await createAcpClientForProject(input.projectId);

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      logger.info({ projectId: input.projectId }, '[StreamSSE] client disconnected');
    });

    try {
      let eventCount = 0;
      for await (const event of acpClient.dispatchStream(input)) {
        await stream.writeSSE({ data: JSON.stringify(event) });
        eventCount++;
      }
      await stream.writeSSE({ data: '[DONE]' });
      logger.info({ projectId: input.projectId, eventCount }, 'Stream dispatch finished');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'Stream dispatch failed');
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'run_failed',
          ts: Date.now(),
          runId: 'error',
          clusterId: input.context?.selectedClusterId ?? 'default-cluster',
          intent: input.intent,
          payload: { reason: message, message },
        }),
      });
      await stream.writeSSE({ data: '[DONE]' });
    }
  });
});

acpRoutes.post('/dispatch', async (c) => {
  logger.info({ path: '/dispatch' }, 'Batch dispatch request received');

  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = dispatchSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Dispatch validation failed');
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const input: DispatchIntentInput = parsed.data;
    logger.info({ projectId: input.projectId, intent: input.intent }, 'Batch dispatch starting');

    const acpClient = await createAcpClientForProject(input.projectId);
    const result = await acpClient.dispatch(input);

    logger.info({ runId: result.runId, eventCount: result.events.length }, 'Batch dispatch completed');
    return c.json({
      runId: result.runId,
      provider: result.provider,
      events: result.events,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ error: message }, 'Batch dispatch failed');
    return c.json({ error: message }, 500);
  }
});
