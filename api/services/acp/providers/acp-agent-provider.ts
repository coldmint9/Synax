import { createWorkspaceClientHandlerForSession } from '../protocol/reverse-handlers.js'
// ---------------------------------------------------------------------------
// Shared ACP provider factory.
//
// Every built-in ACP provider is a local agent runtime that speaks ACP over
// stdio JSON-RPC:
//   - opencode  -> `opencode acp`            (native)
//   - cursor    -> `cursor-agent acp`        (native)
//   - codex     -> `codex-acp`               (adapter wrapping Codex App Server)
//   - pi        -> `pi-acp`                  (adapter wrapping pi coding agent)
//
// The dispatch lifecycle is identical for all of them, so one client
// implementation is parameterized by provider metadata (spawn resolution,
// labels, install hints) instead of being copy-pasted per provider.
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
  ProviderId,
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
  spawnAcpConnection,
  type AcpConnection,
  type AcpSpawnSpec,
} from '../protocol/acp-connection.js'
import type { AcpProvider } from '../registry/provider-registry.js'

/** Hard ceiling for an entire dispatch cycle. */
const DISPATCH_TIMEOUT_MS = 30 * 60_000

export interface AcpAgentProviderMeta {
  id: ProviderId
  label: string
  description: string
  /** Short tag used in log lines, e.g. 'CodexAcp'. */
  logTag: string
  /** Short process name used in exit errors, e.g. 'codex-acp'. */
  processLabel: string
  /**
   * Resolve the spawn spec for the local ACP CLI/adapter. May be async (e.g.
   * cursor must probe several candidate binaries first). Throw with an install
   * hint when the CLI is not installed.
   */
  resolveSpawn(): AcpSpawnSpec | Promise<AcpSpawnSpec>
}

class AcpAgentClient implements AcpClient {
  constructor(private readonly meta: AcpAgentProviderMeta) {}

  async *dispatchStream(
    input: DispatchIntentInput,
  ): AsyncGenerator<CoordinatesRunEvent> {
    const runId = nanoid()
    const clusterId = input.context?.selectedClusterId ?? 'default-cluster'
    const base: MapperBase = { runId, clusterId, intent: input.intent }

    logger.info(
      { runId, intent: input.intent },
      `[${this.meta.logTag}] dispatchStream started`,
    )

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
    logger.info(
      { runId, eventCount: events.length },
      `[${this.meta.logTag}] dispatch finished`,
    )
    return { runId, provider: this.meta.id, events }
  }

  // -------------------------------------------------------------------------
  // Internal: run the full ACP protocol flow and stream events into the queue
  // -------------------------------------------------------------------------

  private async _run(
    input: DispatchIntentInput,
    base: MapperBase,
    queue: AsyncQueue<CoordinatesRunEvent>,
  ): Promise<void> {
    const { id: providerId, logTag, processLabel, resolveSpawn } = this.meta
    let ts = Date.now()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let acpConn: AcpConnection | undefined
    const sourceLinkHints: SourceLinkHint[] = []
    let baseline: Awaited<ReturnType<typeof captureFileChangeBaseline>> | undefined

    // run_started immediately so the consumer sees progress even before spawn.
    queue.push({
      ...base,
      type: 'run_started',
      ts: (ts += 1),
      payload: { provider: providerId, providerId },
    })

    try {
      const workDir = input.context?.workDir
      if (!workDir) throw new Error('An explicit workspace is required for ACP execution.')
      baseline = await captureFileChangeBaseline(workDir)
      const spawnSpec = await resolveSpawn()
      acpConn = spawnAcpConnection(createWorkspaceClientHandlerForSession(workDir, input.sessionId ?? null, {
        sessionUpdate: async (params: SessionNotification) => {
          ts += 1
          const event = mapSessionUpdate(base, ts, params.update)
          if (event) {
            if (event.payload?.sourceLinkHints?.length) {
              sourceLinkHints.push(...event.payload.sourceLinkHints)
            }
            queue.push(event)
            logger.debug(
              { sessionUpdate: params.update.sessionUpdate },
              `[${logTag}] session/update -> event pushed`,
            )
          }
        },
      }), spawnSpec, workDir)

      // Spawn error watchdog (EINVAL, ENOENT, etc.)
      const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
        acpConn!.child.once('error', (err) => reject(err))
        acpConn!.child.once('exit', (code, signal) => {
          if (code !== 0 && code !== null) {
            reject(
              new Error(
                `${processLabel} exited with code ${code}${signal ? ` (signal=${signal})` : ''}`,
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

      logger.info({ runId: base.runId }, `[${logTag}] protocol flow finished`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stderr = acpConn?.stderrChunks.join('') ?? ''
      logger.error(
        { runId: base.runId, err: message, stderr },
        `[${logTag}] dispatch failed`,
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
// Provider descriptor factory
// ---------------------------------------------------------------------------

export function createAcpAgentProvider(meta: AcpAgentProviderMeta): AcpProvider {
  return {
    id: meta.id,
    label: meta.label,
    description: meta.description,
    status: 'live',
    caps: { canFollowUp: true, canCancel: true },
    createClient: () => new AcpAgentClient(meta),
  }
}
