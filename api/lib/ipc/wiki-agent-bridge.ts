import type { ChildProcess } from 'node:child_process';
import { sessionProcessManager } from '../../services/agent-runtime/session-process-manager.js';
import { logger } from '../logger.js';
import type { WikiAgentChildToParentMessage } from './protocol.js';

const activeRequests = new Map<string, AbortController>();

export function handleWikiAgentChildMessage(
  wikiChild: ChildProcess,
  message: WikiAgentChildToParentMessage,
): void {
  if (message.type === 'agent:cancel') {
    const controller = activeRequests.get(message.requestId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(message.reason ?? 'Wiki agent request cancelled.'));
    }
    activeRequests.delete(message.requestId);
    return;
  }

  const abortController = new AbortController();
  activeRequests.set(message.requestId, abortController);

  logger.info(
    {
      requestId: message.requestId,
      sessionId: message.sessionId,
      mode: message.mode,
      wikiChildPid: wikiChild.pid,
    },
    '[wiki-agent] request received from wiki child',
  );

  void (async () => {
    try {
      for await (const chunk of sessionProcessManager.streamSession(
        message.sessionId,
        message.mode,
        message.input,
        abortController.signal,
      )) {
        if (!wikiChild.connected) break;
        wikiChild.send({
          type: 'agent:chunk',
          requestId: message.requestId,
          chunk,
        });
      }
      if (wikiChild.connected) {
        wikiChild.send({ type: 'agent:done', requestId: message.requestId });
      }
      logger.info(
        { requestId: message.requestId, sessionId: message.sessionId, wikiChildPid: wikiChild.pid },
        '[wiki-agent] request completed',
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (wikiChild.connected) {
        wikiChild.send({ type: 'agent:error', requestId: message.requestId, error });
      }
      logger.error(
        { err, requestId: message.requestId, sessionId: message.sessionId, wikiChildPid: wikiChild.pid },
        '[wiki-agent] request failed',
      );
    } finally {
      activeRequests.delete(message.requestId);
    }
  })();
}

export function cancelWikiAgentRequestsForChild(wikiChildPid: number | undefined): void {
  if (activeRequests.size === 0) return;
  logger.warn({ wikiChildPid, activeCount: activeRequests.size }, '[wiki-agent] cancelling pending requests');
  for (const [requestId, controller] of activeRequests) {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Wiki job child process exited.'));
    }
    activeRequests.delete(requestId);
  }
}
