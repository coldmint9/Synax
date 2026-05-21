// ---------------------------------------------------------------------------
// CursorAcpProvider — live provider backed by `cursor-agent acp` CLI.
//
// Composition (SDK-powered):
//   child_process.spawn          (stdio pipes)
//     |
//   Readable/Writable.toWeb      (Node -> Web Streams adapters)
//     |
//   ndJsonStream                 (NDJSON framing for JSON-RPC messages)
//     |
//   ClientSideConnection         (SDK: initialize / newSession / prompt)
//     |
//   createClientHandler          (our Client handler: permission, fs, update)
//     |
//   mapSessionUpdate             (SDK SessionUpdate -> CoordinatesRunEvent)
//     |
//   AsyncQueue                   (push -> yield to HTTP SSE stream)
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
  spawnAcpConnection,
  initializeSession,
  resolveCursorSpawn,
  type AcpConnection,
} from '../protocol/acp-connection.js'
import type { AcpProvider } from '../registry/provider-registry.js'

/** Hard ceiling for an entire dispatch cycle. */
const DISPATCH_TIMEOUT_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

class CursorAcpClient implements AcpClient {
  async *dispatchStream(
    input: DispatchIntentInput,
  ): AsyncGenerator<CoordinatesRunEvent> {
    const runId = nanoid()
    const clusterId = input.context?.selectedClusterId ?? 'default-cluster'
    const base: MapperBase = { runId, clusterId, intent: input.intent }

    logger.info({ runId, intent: input.intent }, '[CursorAcp] dispatchStream started')

    const queue = new AsyncQueue<CoordinatesRunEvent>()

    // Kick off the protocol in the background; events flow into `queue`.
    // Any thrown error is caught inside _run and translated to run_failed.
    void this._run(input, base, queue)

    yield* queue
  }

  async dispatch(input: DispatchIntentInput): Promise<DispatchIntentResult> {
    const events: CoordinatesRunEvent[] = []
    for await (const ev of this.dispatchStream(input)) {
      events.push(ev)
    }
    const runId = events.find((e) => e.type === 'run_started')?.runId ?? nanoid()
    logger.info({ runId, eventCount: events.length }, '[CursorAcp] dispatch finished')
    return { runId, provider: 'cursor-acp', events }
  }

  // -------------------------------------------------------------------------
  // Internal: run the full ACP protocol flow and stream events into the queue
  // -------------------------------------------------------------------------

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

    // run_started immediately so the consumer sees progress even before spawn.
    queue.push({
      ...base,
      type: 'run_started',
      ts: (ts += 1),
      payload: { provider: 'cursor-acp', providerId: 'cursor-acp' },
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
              '[CursorAcp] session/update -> event pushed',
            )
          }
        },
      }, resolveCursorSpawn())

      // Spawn error watchdog (EINVAL, ENOENT, etc.)
      const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
        acpConn!.child.once('error', (err) => reject(err))
        acpConn!.child.once('exit', (code, signal) => {
          if (code !== 0 && code !== null) {
            reject(
              new Error(
                `cursor-agent exited with code ${code}${signal ? ` (signal=${signal})` : ''}`,
              ),
            )
          }
        })
      })

      // Global timeout watchdog
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('ACP dispatch timed out')),
          DISPATCH_TIMEOUT_MS,
        )
      })

      const protocolFlow = async (): Promise<void> => {
        const sessionId = await initializeSession(acpConn!.conn, input.context?.workDir ?? undefined)
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

      logger.info({ runId: base.runId }, '[CursorAcp] protocol flow finished')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stderr = acpConn?.stderrChunks.join('') ?? ''
      logger.error(
        { runId: base.runId, err: message, stderr },
        '[CursorAcp] dispatch failed',
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

// ---------------------------------------------------------------------------
// Provider descriptor
// ---------------------------------------------------------------------------

export const cursorAcpProvider: AcpProvider = {
  id: 'cursor-acp',
  label: 'Cursor ACP',
  description: 'Cursor 官方 Agent，通过本地 cursor-agent CLI 以 JSON-RPC over stdio 通信（@agentclientprotocol/sdk）',
  status: 'live',
  caps: { canFollowUp: true, canCancel: true },
  createClient: () => new CursorAcpClient(),
}
