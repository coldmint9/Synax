import { recordRuntimeStream } from '../../services/agent-runtime/runtime-stream-writer.js';
import type { ChildProcess } from 'node:child_process';
import { sessionProcessManager } from '../../services/agent-runtime/session-process-manager.js';
import { logger } from '../logger.js';
import type { WikiAgentChildToParentMessage } from './protocol.js';

const activeRequests = new Map<string, { controller: AbortController; childPid: number | undefined }>();

export function handleWikiAgentChildMessage(
  wikiChild: ChildProcess,
  message: WikiAgentChildToParentMessage,
): void {
  if (message.type === 'agent:cancel') {
    const owned = activeRequests.get(message.requestId);
    if (owned && owned.childPid === wikiChild.pid && !owned.controller.signal.aborted) {
      owned.controller.abort(new Error(message.reason ?? 'Wiki agent request cancelled.'));
    }
    return;
  }

  if (activeRequests.has(message.requestId)) {
    if (wikiChild.connected) wikiChild.send({ type: 'agent:error', requestId: message.requestId, error: 'Request ID is already active.' });
    return;
  }
  const abortController = new AbortController();
  const owned = { controller: abortController, childPid: wikiChild.pid };
  activeRequests.set(message.requestId, owned);

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
      for await (const chunk of recordRuntimeStream(message.sessionId, sessionProcessManager.streamSession(
        message.sessionId,
        message.mode,
        message.input,
        abortController.signal,
      ))) {
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
      if (activeRequests.get(message.requestId) === owned) activeRequests.delete(message.requestId);
    }
  })();
}

export function cancelWikiAgentRequestsForChild(wikiChildPid: number | undefined): void {
  if (wikiChildPid === undefined) return;
  for (const owned of activeRequests.values()) {
    if (owned.childPid === wikiChildPid && !owned.controller.signal.aborted) {
      owned.controller.abort(new Error('Wiki job child process exited.'));
    }
  }
}
