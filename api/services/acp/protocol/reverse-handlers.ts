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
// Default permissions fail closed without an explicit owner:
//   - permissions are cancelled unless the provider supplies an approval handler
//   - reads require an explicit workspace-bound handler
//   - unsupported writes fail rather than acknowledging nonexistent changes
//
// Providers supply their own `sessionUpdate` (to pipe into their event queue)
// and may override any other handler via `overrides`.
// ---------------------------------------------------------------------------

import type { Client } from '@agentclientprotocol/sdk'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { isWorkspaceRelativePathBlocked } from '../../agent-runtime/tools/workspace.js'
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
    async requestPermission() {
      return { outcome: { outcome: 'cancelled' } }
    },

    async sessionUpdate(params) {
      logger.debug(
        { sessionId: params.sessionId, kind: params.update.sessionUpdate },
        '[ClientHandler] session/update dropped (no override)',
      )
    },

    async readTextFile() {
      throw new Error('Filesystem reads require a bound workspace.')
    },

    async writeTextFile() {
      throw new Error('Client filesystem writes are not supported.')
    },
  }

  return { ...base, ...overrides }
}


export function createWorkspaceClientHandler(workDir: string, overrides: ClientOverrides = {}): Client {
  return createClientHandler({
    async readTextFile(params) {
      const root = await realpath(workDir)
      const target = await realpath(path.resolve(root, params.path))
      const relative = path.relative(root, target)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('The requested file is outside the bound workspace.')
      }
      if (isWorkspaceRelativePathBlocked(relative)) throw new Error('This workspace path is protected.')
      const info = await stat(target)
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Requested file is not a supported text file (maximum 2 MiB).')
      const content = await readFile(target, 'utf8')
      if (params.line == null && params.limit == null) return { content }
      const start = Math.max(0, (params.line ?? 1) - 1)
      return { content: content.split(/\r?\n/).slice(start, params.limit == null ? undefined : start + params.limit).join('\n') }
    },
    ...overrides,
  })
}
