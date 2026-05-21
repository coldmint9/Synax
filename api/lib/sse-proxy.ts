// ---------------------------------------------------------------------------
// api/lib/sse-proxy.ts — 本地 analyzer SSE 转发 helper
//
// 仍保留原始路由调用点。这里直接消费 Bun analyzer-service
// 生成的事件流，并按 SSE 规范写回客户端。
// ---------------------------------------------------------------------------

import type { Context } from 'hono';
import { logger } from './logger.js';
import { createLocalAnalyzerStream } from '../services/analyzer-client.js';

export interface ProxyUpstreamSSEOptions {
  scope: string;
  logContext?: Record<string, unknown>;
  llmPurpose?: string;
}

export async function proxyUpstreamSSE(
  c: Context,
  upstreamPath: '/analyze' | '/reanalyze' | '/review/goal',
  body: unknown,
  opts: ProxyUpstreamSSEOptions,
): Promise<Response> {
  const logCtx = { scope: opts.scope, upstreamPath, ...(opts.logContext ?? {}) };
  const controller = new AbortController();
  const clientSignal = c.req.raw.signal;
  if (clientSignal.aborted) {
    controller.abort();
  } else {
    clientSignal.addEventListener(
      'abort',
      () => {
        logger.info(logCtx, '[sse-proxy] client aborted, cancelling local stream');
        controller.abort();
      },
      { once: true },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      try {
        for await (const event of createLocalAnalyzerStream(upstreamPath, body)) {
          if (controller.signal.aborted) break;
          streamController.enqueue(encoder.encode(formatSseEvent(event)));
        }
        if (!controller.signal.aborted) {
          streamController.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ ...logCtx, err: message }, '[sse-proxy] local stream failed');
        streamController.enqueue(encoder.encode(formatSseEvent(fallbackError(upstreamPath, message))));
      } finally {
        streamController.close();
      }
    },
    cancel() {
      controller.abort();
    },
  });

  c.header('Content-Type', 'text/event-stream; charset=utf-8');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return c.body(stream);
}

function formatSseEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function fallbackError(
  upstreamPath: '/analyze' | '/reanalyze' | '/review/goal',
  reason: string,
): Record<string, unknown> {
  if (upstreamPath === '/review/goal') {
    return { type: 'review_failed', payload: { reason } };
  }
  return { type: 'analysis_failed', payload: { reason } };
}
