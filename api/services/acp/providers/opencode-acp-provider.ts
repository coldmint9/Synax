// ---------------------------------------------------------------------------
// OpenCodeAcpProvider - live provider backed by `opencode acp` CLI.
// ---------------------------------------------------------------------------

import type { SessionNotification } from '@agentclientprotocol/sdk'
import { nanoid } from 'nanoid'
import { logger } from '../../../lib/logger.js'
import type {
  AcpClient,
  CoordinatesRunEvent,
  DispatchIntentInput,
  DispatchIntentResult,
} from '../contracts.js'
import {
  captureFileChangeBaseline,
  captureFileChanges,
  type SourceLinkHint,
} from '../file-change-capture.js'
import { mapSessionUpdate, type MapperBase } from '../mapper/session-update-mapper.js'
import { AsyncQueue } from '../protocol/async-queue.js'
import {
  initializeSession,
  resolveOpenCodeSpawn,
  spawnAcpConnection,
  type AcpConnection,
} from '../protocol/acp-connection.js'
import type { AcpProvider } from '../registry/provider-registry.js'

/** Hard ceiling for an entire dispatch cycle. */
const DISPATCH_TIMEOUT_MS = 30 * 60_000

class OpenCodeAcpClient implements AcpClient {
  async *dispatchStream(
    input: DispatchIntentInput,
  ): AsyncGenerator<CoordinatesRunEvent> {
    const runId = nanoid()
    const clusterId = input.context?.selectedClusterId ?? 'default-cluster'
    const base: MapperBase = { runId, clusterId, intent: input.intent }

    logger.info({ runId, intent: input.intent }, '[OpenCodeAcp] dispatchStream started')

    const queue = new AsyncQueue<CoordinatesRunEvent>()
    void this._run(input, base, queue)

    yield* queue
  }

  async dispatch(input: DispatchIntentInput): Promise<DispatchIntentResult> {
    const events: CoordinatesRunEvent[] = []
    for await (const ev of this.dispatchStream(input)) {
      events.push(ev)
    }
    const runId = events.find((e) => e.type === 'run_started')?.runId ?? nanoid()
    logger.info({ runId, eventCount: events.length }, '[OpenCodeAcp] dispatch finished')
    return { runId, provider: 'opencode-acp', events }
  }

  private async _run(
    input: DispatchIntentInput,
    base: MapperBase,
    queue: AsyncQueue<CoordinatesRunEvent>,
  ): Promise<void> {
    let ts = Date.now()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let acpConn: AcpConnection | undefined
    const sourceLinkHints: SourceLinkHint[] = []
    const baseline = await captureFileChangeBaseline(input.context?.workDir)

    queue.push({
      ...base,
      type: 'run_started',
      ts: (ts += 1),
      payload: { provider: 'opencode-acp', providerId: 'opencode-acp' },
    })

    try {
      acpConn = spawnAcpConnection({
        async sessionUpdate(params: SessionNotification) {
          ts += 1
          const event = mapSessionUpdate(base, ts, params.update)
          if (event) {
            if (event.payload?.sourceLinkHints?.length) {
              sourceLinkHints.push(...event.payload.sourceLinkHints)
            }
            queue.push(event)
            logger.debug(
              { sessionUpdate: params.update.sessionUpdate },
              '[OpenCodeAcp] session/update -> event pushed',
            )
          }
        },
      }, resolveOpenCodeSpawn())

      const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
        acpConn!.child.once('error', (err) => reject(err))
        acpConn!.child.once('exit', (code, signal) => {
          if (code !== 0 && code !== null) {
            reject(
              new Error(
                `opencode exited with code ${code}${signal ? ` (signal=${signal})` : ''}`,
              ),
            )
          }
        })
      })

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('ACP dispatch timed out')),
          DISPATCH_TIMEOUT_MS,
        )
      })

      const protocolFlow = async (): Promise<void> => {
        const session = await initializeSession(acpConn!.conn, input.context?.workDir ?? undefined)
        const sessionId = session.sessionId
        const contextPrompt = input.context?.contextPrompt
          ? `\n\n[Coordinates Context Snapshot]\n${input.context.contextPrompt}`
          : ''

        const promptResult = await acpConn!.conn.prompt({
          sessionId,
          prompt: [
            {
              type: 'text',
              text: `[Project: ${input.projectId}] [User: ${input.userName}]${contextPrompt}\n\n${base.intent}`,
            },
          ],
        })

        ts += 1
        const stopReason = promptResult.stopReason ?? 'end_turn'
        if (stopReason === 'refusal' || stopReason === 'cancelled') {
          queue.push({
            ...base,
            type: 'run_failed',
            ts,
            payload: {
              reason: `Agent stopped: ${stopReason}`,
              message: `Stop reason: ${stopReason}`,
            },
          })
        } else {
          const changes = await captureFileChanges(input.context?.workDir, sourceLinkHints, baseline)
          queue.push({
            ...base,
            type: 'run_completed',
            ts,
            payload: {
              message: `Run completed (stopReason: ${stopReason}).`,
              fileChanges: changes.fileChanges,
              changeSummary: changes.changeSummary,
            },
          })
        }
      }

      await Promise.race([protocolFlow(), timeoutPromise, spawnErrorPromise])

      logger.info({ runId: base.runId }, '[OpenCodeAcp] protocol flow finished')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stderr = acpConn?.stderrChunks.join('') ?? ''
      logger.error(
        { runId: base.runId, err: message, stderr },
        '[OpenCodeAcp] dispatch failed',
      )
      queue.push({
        ...base,
        type: 'run_failed',
        ts: Date.now(),
        payload: { reason: message, message },
      })
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      acpConn?.cleanup()
      queue.close()
    }
  }
}

export const openCodeAcpProvider: AcpProvider = {
  id: 'opencode-acp',
  label: 'OpenCode ACP',
  description: 'OpenCode Agent Client Protocol - local opencode CLI over JSON-RPC stdio',
  status: 'live',
  caps: { canFollowUp: true, canCancel: true },
  createClient: () => new OpenCodeAcpClient(),
}
