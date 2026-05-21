// ---------------------------------------------------------------------------
// SDK Client handler factory.
//
// Builds an object conforming to `@agentclientprotocol/sdk`'s `Client`
// interface. The agent may call back into the client for:
//   - session/request_permission  (ask user to approve an action)
//   - session/update              (notification; streamed progress)
//   - fs/read_text_file           (read a file the agent wants to inspect)
//   - fs/write_text_file          (write a file the agent produced)
//
// Defaults are safe-ish for MVP:
//   - permissions auto-approve the FIRST option (SDK requires an optionId)
//   - reads honored (agent can inspect workspace files)
//   - writes acknowledged but NOT actually persisted
//
// Providers supply their own `sessionUpdate` (to pipe into their event queue)
// and may override any other handler via `overrides`.
// ---------------------------------------------------------------------------

import type { Client } from '@agentclientprotocol/sdk'
import { readFile } from 'node:fs/promises'
import { logger } from '../../../lib/logger.js'

/** Partial override map. All fields optional; undefined falls back to default. */
export type ClientOverrides = Partial<Client>

/**
 * Build a `Client` implementation for passing to `ClientSideConnection`.
 *
 * `sessionUpdate` MUST be supplied by the caller (via overrides) — the
 * provider is responsible for translating updates into its own event stream.
 * If absent, updates are silently logged and dropped.
 */
export function createClientHandler(overrides: ClientOverrides = {}): Client {
  const base: Client = {
    async requestPermission(params) {
      const firstOption = params.options[0]
      if (!firstOption) {
        logger.warn(
          { toolCallId: params.toolCall.toolCallId },
          '[ClientHandler] permission request has no options → cancelled',
        )
        return { outcome: { outcome: 'cancelled' } }
      }
      logger.info(
        {
          toolCallId: params.toolCall.toolCallId,
          optionId: firstOption.optionId,
          kind: firstOption.kind,
        },
        '[ClientHandler] auto-selecting first permission option',
      )
      return {
        outcome: {
          outcome: 'selected',
          optionId: firstOption.optionId,
        },
      }
    },

    async sessionUpdate(params) {
      logger.debug(
        { sessionId: params.sessionId, kind: params.update.sessionUpdate },
        '[ClientHandler] session/update dropped (no override)',
      )
    },

    async readTextFile(params) {
      try {
        const content = await readFile(params.path, 'utf-8')
        return { content }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn(
          { path: params.path, err: message },
          '[ClientHandler] fs/read_text_file failed',
        )
        return { content: '' }
      }
    },

    async writeTextFile(params) {
      logger.info(
        { path: params.path, length: params.content?.length ?? 0 },
        '[ClientHandler] fs/write_text_file (ack only, not persisted)',
      )
      return {}
    },
  }

  return { ...base, ...overrides }
}
