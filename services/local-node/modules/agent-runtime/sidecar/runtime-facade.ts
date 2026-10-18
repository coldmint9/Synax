import { createHash } from "node:crypto";
import {
  decodeUiSnapshot,
  type RuntimeRecordState,
} from "../../../../../packages/runtime-protocol/stream.js";
import { normalizeUsage } from "../../../infrastructure/llm-runtime/usage.js";
import { logger } from "../../../infrastructure/runtime/logger.js";
import { projectCacheUsage } from "../cache-usage.js";
import type {
  AgentRun,
  AgentRunStep,
  AgentRunStreamChunk,
  AgentRuntimeMessage,
  AgentSession,
  RuntimeEvent,
  ToolCallRecord,
} from "../contracts.js";
import type { AcceptedRuntimeInput } from "../run-admission.js";
import { AgentRuntimeError } from "../runtime-errors.js";
import { agentRuntimeStore } from "../session-store.js";
import { RuntimeSidecarClient, RuntimeSidecarError } from "./sidecar-client.js";
import { readHistoryList, readSessionList } from './history-pages.js';
export type RuntimeSidecarStreamMode = "authoritative";
function streamMode(): RuntimeSidecarStreamMode {
  return "authoritative";
}
let connection:
  | {
      socketPath: string;
      token: string;
      client: RuntimeSidecarClient;
    }
  | undefined;
let historyReadSequence = 0;
const historyReadRequest = (operation: string, sessionId: string) =>
  `history-read:${operation}:${sessionId}:${++historyReadSequence}`;
function makeClient(): RuntimeSidecarClient | null {
  const socketPath = process.env.SYNAX_RUNTIME_SIDECAR_SOCKET;
  const token = process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
  if (!socketPath || !token) {
    connection?.client.close();
    connection = undefined;
    return null;
  }
  if (
    !connection ||
    connection.socketPath !== socketPath ||
    connection.token !== token
  ) {
    connection?.client.close();
    connection = {
      socketPath,
      token,
      client: new RuntimeSidecarClient({ socketPath, token }),
    };
  }
  return connection.client;
}
export interface RuntimeAdmissionInput {
  sessionId: string;
  run: AgentRun;
  runtime: AcceptedRuntimeInput;
}
export interface RuntimeStreamInput {
  sessionId: string;
  runId: string;
  producerId: string;
  producerSequence: number;
  epoch: number;
  revision: number;
  chunks: unknown[];
  state: RuntimeRecordState;
}
export class RuntimeFacade {
  private readonly pendingHistoryWrites = new Map<string, Set<Promise<void>>>();
  constructor(
    private readonly clientFactory: () => RuntimeSidecarClient | null = makeClient,
  ) {}
  streamMode(): RuntimeSidecarStreamMode {
    return streamMode();
  }
  enabled(): boolean {
    return this.clientFactory() !== null;
  }
  /** Admission is awaited before starting provider/tool execution. */
  async admitExecution(
    input: RuntimeAdmissionInput,
    activate = true,
  ): Promise<{
    reused: boolean;
    epoch: number;
    revision: number;
  }> {
    const client = this.clientFactory();
    if (!client) {
      throw new Error("Runtime sidecar client is not configured.");
    }
    {
      await this.ensureUiProjection(input.sessionId);
      let admission: Awaited<ReturnType<RuntimeSidecarClient["admitRun"]>>;
      for (let attempt = 0; ; attempt++) {
        const state = await client.snapshot(input.sessionId);
        try {
          admission = await client.admitRun({
            sessionId: input.sessionId,
            requestId: input.runtime.requestId,
            bodyHash: input.runtime.inputHash,
            runId: input.run.id,
            run: input.run,
            epoch: state.epoch,
            revision: state.revision,
            queueItem: input.runtime.queueItem,
          });
          break;
        } catch (error) {
          if (
            !(error instanceof RuntimeSidecarError) ||
            error.code !== "REVISION_CONFLICT" ||
            attempt >= 7
          )
            throw error;
        }
      }
      if (admission.runId !== input.run.id)
        throw new Error("Runtime admission returned a different run identity.");
      if (activate && input.run.status === "queued") {
        for (let attempt = 0; ; attempt++) {
          const fence = await client.snapshot(input.sessionId);
          if (
            fence.activeRunId !== input.run.id ||
            fence.epoch !== admission.epoch
          )
            throw new Error("Runtime activation fence changed.");
          try {
            const activated = await client.activateRun({
              requestId: `${input.runtime.requestId}:activate`,
              sessionId: input.sessionId,
              epoch: fence.epoch,
              revision: fence.revision,
              run: input.run,
            });
            if (
              activated.activeRunId !== input.run.id ||
              activated.epoch !== admission.epoch
            )
              throw new Error(
                "Runtime activation returned an invalid run fence.",
              );
            break;
          } catch (error) {
            if (
              !(error instanceof RuntimeSidecarError) ||
              error.code !== "REVISION_CONFLICT" ||
              attempt >= 7
            )
              throw error;
          }
        }
      }
      const current = await client.snapshot(input.sessionId);
      if (
        current.activeRunId !== input.run.id ||
        current.epoch !== admission.epoch
      )
        throw new Error("Cannot relaunch a completed or superseded run.");
      return {
        reused: admission.reused,
        epoch: current.epoch,
        revision: current.revision,
      };
    }
  }
  async finishExecution(sessionId: string, run: AgentRun): Promise<void> {
    const status = run.status;
    if (
      status !== "completed" &&
      status !== "failed" &&
      status !== "cancelled" &&
      status !== "interrupted" &&
      status !== "blocked"
    )
      return;
    const client = this.clientFactory();
    if (!client) {
      throw new Error("Runtime sidecar client is not configured.");
    }
    {
      await this.flushHistoryWrites(sessionId);
      for (let attempt = 0; ; attempt++) {
        const state = await client.snapshot(sessionId);
        try {
          await client.finishRun({
            sessionId,
            runId: run.id,
            requestId: `finish:${run.id}`,
            status,
            epoch: state.epoch,
            revision: state.revision,
            run,
          });
          break;
        } catch (error) {
          if (
            !(error instanceof RuntimeSidecarError) ||
            error.code !== "REVISION_CONFLICT" ||
            attempt >= 7
          )
            throw error;
        }
      }
      try {
        await this.persistRunHistory(run);
      } catch (error) {
        logger.warn(
          {
            sessionId,
            runId: run.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "[runtime-sidecar] terminal run history persistence failed",
        );
        throw error;
      }
    }
  }
  async ensureUiProjection(sessionId: string): Promise<void> {
    await agentRuntimeStore.flushSession(sessionId);
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    await client.uiSnapshot(sessionId);
  }
  async queueMutation(input: {
    sessionId: string;
    requestId: string;
    operation:
      | "enqueue"
      | "remove"
      | "move"
      | "force"
      | "clear_force"
      | "consume"
      | "ack_consume";
    payload?: unknown;
  }): Promise<Uint8Array | null> {
    await this.ensureUiProjection(input.sessionId);
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    for (let attempt = 0; ; attempt++) {
      const snapshot = await client.snapshot(input.sessionId);
      try {
        return await client.queueMutation({
          ...input,
          epoch: snapshot.epoch,
          revision: snapshot.revision,
          payload: input.payload ?? null,
        });
      } catch (error) {
        // No write occurred on revision conflict; retry the same semantic command against fresh state.
        if (
          !(error instanceof RuntimeSidecarError) ||
          error.code !== "REVISION_CONFLICT" ||
          attempt >= 7
        )
          throw error;
      }
    }
  }
  async queueSnapshot(sessionId: string): Promise<unknown> {
    await agentRuntimeStore.flushSession(sessionId);
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    return JSON.parse(Buffer.from(await client.queueRead(sessionId)).toString('utf8'));
  }
  async controlState(sessionId: string): Promise<unknown> {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    await this.ensureUiProjection(sessionId);
    for (let attempt = 0; ; attempt++) {
      const snapshot = await client.snapshot(sessionId);
      try {
        const result = await client.controlCommand({
          sessionId,
          requestId: `control-read:${sessionId}:${snapshot.epoch}:${snapshot.revision}`,
          epoch: snapshot.epoch,
          revision: snapshot.revision,
          operation: "read",
        });
        return JSON.parse(Buffer.from(result.stateJson).toString("utf8"));
      } catch (error) {
        if (
          !(error instanceof RuntimeSidecarError) ||
          error.code !== "REVISION_CONFLICT" ||
          attempt >= 7
        )
          throw error;
      }
    }
  }
  async controlCommand(input: {
    sessionId: string;
    requestId: string;
    operation: string;
    payload?: unknown;
  }): Promise<unknown> {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    await this.ensureUiProjection(input.sessionId);
    for (let attempt = 0; ; attempt++) {
      const snapshot = await client.snapshot(input.sessionId);
      try {
        const result = await client.controlCommand({
          ...input,
          epoch: snapshot.epoch,
          revision: snapshot.revision,
        });
        const state = JSON.parse(Buffer.from(result.stateJson).toString("utf8"));
        if (state.entity) {
          await client.historyCommand({ sessionId: input.sessionId,
            requestId: `control-history:${createHash('sha256').update(input.requestId).digest('hex')}`,
            operation: 'reconcile_stream', payload: {} });
        }
        return state;
      } catch (error) {
        if (
          !(error instanceof RuntimeSidecarError) ||
          error.code !== "REVISION_CONFLICT" ||
          attempt >= 7
        )
          throw error;
      }
    }
  }
  async sessionPatch(
    sessionId: string,
    requestId: string,
    patch: Record<string, unknown>,
  ): Promise<unknown> {
    await this.controlCommand({
      sessionId,
      requestId,
      operation: "session_patch",
      payload: { patch },
    });
    return (await this.uiSnapshotAuthoritative(sessionId)).session;
  }
  async runPatch(
    sessionId: string,
    runId: string,
    requestId: string,
    patch: Record<string, unknown>,
  ): Promise<unknown> {
    await this.controlCommand({
      sessionId,
      requestId,
      operation: "run_patch",
      payload: { runId, patch },
    });
    return (await this.uiSnapshotAuthoritative(sessionId)).run;
  }
  async stopSessionAuthoritative(
    sessionId: string,
    status: "paused" | "interrupted" | "cancelled",
    reason: string,
  ): Promise<void> {
    const snapshot = await this.uiSnapshotAuthoritative(sessionId);
    const now = new Date().toISOString();
    const run = snapshot.run as AgentRun | null;
    if (
      run &&
      ["queued", "running", "waiting_permission", "waiting_input"].includes(
        String(run.status),
      )
    ) {
      await this.finishExecution(sessionId, {
        ...run,
        status: "interrupted",
        completedAt: now,
        stopReason: reason,
        metadata: {
          ...run.metadata,
          executionLease: {
            ...((run.metadata?.executionLease as
              | Record<string, unknown>
              | undefined) ?? {}),
            closed: true,
          },
        },
      });
    }
    await this.sessionPatch(
      sessionId,
      `stop-session:${sessionId}:${status}:${now}`,
      {
        status,
        activeRunId: null,
        pendingResumeToken: null,
        blockedReason: null,
        resultSummary: reason,
        completedAt: status === "interrupted" ? now : null,
        updatedAt: now,
        sessionMetadata: {
          manualStop: { at: now, reason },
          runtimeControl: null,
        },
      },
    );
  }
  async historyCommand(input: {
    sessionId: string;
    requestId: string;
    operation: string;
    payload?: unknown;
  }): Promise<unknown> {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    let bytes: Uint8Array;
    bytes = await client.historyCommand(input);
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  }
  async historyCommandGlobal(input: {
    scopeId: string;
    requestId: string;
    operation: string;
    payload?: unknown;
  }): Promise<unknown> {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    const bytes = await client.historyCommandGlobal({
      sessionId: input.scopeId,
      requestId: input.requestId,
      operation: input.operation,
      payload: input.payload,
    });
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  }
  async historyOutboxStatus(
    sessionId: string,
    limit = 4096,
  ): Promise<{
    pending: number;
    firstSequence?: number;
    lastSequence?: number;
    truncated: boolean;
  }> {
    return (await this.historyCommand({
      sessionId,
      requestId: `history-outbox-status:${sessionId}:${limit}`,
      operation: "history_outbox_status",
      payload: { limit },
    })) as {
      pending: number;
      firstSequence?: number;
      lastSequence?: number;
      truncated: boolean;
    };
  }
  async maintainHistoryOutbox(
    sessionId: string,
    maxEntries = 256,
  ): Promise<{
    ackedThrough: number;
    removed: number;
    hasMoreAcked: boolean;
  }> {
    return (await this.historyCommand({
      sessionId,
      requestId: `history-outbox-maintain:${sessionId}:${maxEntries}`,
      operation: "maintain_history_outbox",
      payload: { maxEntries },
    })) as {
      ackedThrough: number;
      removed: number;
      hasMoreAcked: boolean;
    };
  }
  async putAssetBlob(
    assetId: string,
    asset: unknown,
    bytes: Uint8Array,
  ): Promise<void> {
    const scopeId = `asset:${assetId}`;
    await this.historyCommandGlobal({
      scopeId: "assets",
      requestId: `asset-metadata:${assetId}:${createHash("sha256").update(JSON.stringify(asset)).digest("hex")}`,
      operation: "asset_put",
      payload: { asset },
    });
    const chunkSize = 256 * 1024;
    const total = Math.max(1, Math.ceil(bytes.length / chunkSize));
    const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
    for (let index = 0; index < total; index++) {
      const chunk = bytes.subarray(
        index * chunkSize,
        Math.min(bytes.length, (index + 1) * chunkSize),
      );
      await this.historyCommandGlobal({
        scopeId,
        requestId: `asset-blob-chunk:${assetId}:${index}`,
        operation: "put_blob_chunk",
        payload: { blobId: assetId, index, total, bytesHex: hex(chunk) },
      });
    }
    await this.historyCommandGlobal({
      scopeId,
      requestId: `asset-blob-manifest:${assetId}`,
      operation: "put_blob_manifest",
      payload: {
        blobId: assetId,
        total,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    await this.historyCommandGlobal({
      scopeId,
      requestId: `asset-object:${assetId}`,
      operation: "put_object",
      payload: { kind: "runtime.asset", value: asset },
    });
  }
  async getAssetMetadata(assetId: string): Promise<unknown> {
    return this.historyCommandGlobal({
      scopeId: "assets",
      requestId: `asset-metadata-read:${assetId}`,
      operation: "asset_get",
      payload: { assetId },
    });
  }
  async bindAsset(sessionId: string, assetId: string): Promise<void> {
    await this.historyCommandGlobal({
      scopeId: "assets",
      requestId: `asset-bind:${sessionId}:${assetId}`,
      operation: "asset_bind",
      payload: { sessionId, assetId },
    });
  }
  async unbindAsset(sessionId: string, assetId: string): Promise<void> {
    await this.historyCommandGlobal({
      scopeId: "assets",
      requestId: `asset-unbind:${sessionId}:${assetId}`,
      operation: "asset_unbind",
      payload: { sessionId, assetId },
    });
  }
  async hasAssetBinding(sessionId: string, assetId: string): Promise<boolean> {
    const result = (await this.historyCommandGlobal({
      scopeId: "assets",
      requestId: `asset-binding-read:${sessionId}:${assetId}`,
      operation: "asset_has_binding",
      payload: { sessionId, assetId },
    })) as {
      bound?: boolean;
    };
    return result.bound === true;
  }
  async listBoundAssets(sessionId: string): Promise<unknown[]> {
    const result = (await this.historyCommandGlobal({
      scopeId: "assets",
      requestId: `asset-bindings-list:${sessionId}`,
      operation: "asset_list_bindings",
      payload: { sessionId },
    })) as {
      items?: unknown[];
    };
    return result.items ?? [];
  }
  async deleteAssetMetadata(assetId: string): Promise<void> {
    await this.historyCommandGlobal({
      scopeId: "assets",
      requestId: `asset-delete:${assetId}`,
      operation: "asset_delete",
      payload: { assetId },
    });
  }
  async deleteAssetBlob(assetId: string): Promise<void> {
    await this.historyCommandGlobal({
      scopeId: `asset:${assetId}`,
      requestId: `asset-blob-delete:${assetId}`,
      operation: "delete_blob",
      payload: { blobId: assetId },
    });
  }
  async readAssetBlob(assetId: string): Promise<Uint8Array> {
    const scopeId = `asset:${assetId}`;
    const manifest = (await this.historyCommandGlobal({
      scopeId,
      requestId: `asset-blob-manifest-read:${assetId}`,
      operation: "get_blob_manifest",
      payload: { blobId: assetId },
    })) as {
      total?: number;
      size?: number;
      sha256?: string;
    };
    const total = Number(manifest.total);
    if (!Number.isSafeInteger(total) || total < 1 || total > 2048)
      throw new Error("Invalid runtime asset blob manifest.");
    const parts: Buffer[] = [];
    for (let index = 0; index < total; index++) {
      const chunk = (await this.historyCommandGlobal({
        scopeId,
        requestId: `asset-blob-chunk-read:${assetId}:${index}`,
        operation: "get_blob_chunk",
        payload: { blobId: assetId, index },
      })) as {
        bytesHex?: string;
      };
      parts.push(Buffer.from(chunk.bytesHex ?? "", "hex"));
    }
    const bytes = Buffer.concat(parts);
    if (manifest.size !== undefined && bytes.length !== manifest.size)
      throw new Error("Runtime asset blob size mismatch.");
    if (
      manifest.sha256 &&
      createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
    )
      throw new Error("Runtime asset blob digest mismatch.");
    return bytes;
  }
  async persistRunHistory(
    run: unknown & {
      id?: string;
      sessionId?: string;
    },
  ): Promise<void> {
    const client = this.clientFactory() as
      | (RuntimeSidecarClient & {
          historyCommand?: unknown;
        })
      | null;
    if (!client || typeof client.historyCommand !== "function") return;
    const sessionId =
      typeof run.sessionId === "string" ? run.sessionId : undefined;
    const runId = typeof run.id === "string" ? run.id : undefined;
    if (!sessionId || !runId) return;
    await this.appendHistoryEntities(sessionId, [
      { kind: "runtime.run", value: run },
    ]);
  }
  /** One bounded command publishes entities, head and receipt atomically in Rust. */
  private async appendHistoryEntities(
    sessionId: string,
    objects: Array<{
      kind: string;
      value: unknown;
    }>,
  ): Promise<void> {
    // Leave room for the protobuf envelope below the 1 MiB control frame limit.
    const budget = 768 * 1024;
    let batch: typeof objects = [];
    let bytes = 16;
    const flush = async () => {
      if (!batch.length) return;
      const payload = { objects: batch };
      await this.historyCommand({
        sessionId,
        requestId: `history-append:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
        operation: "append_entities",
        payload,
      });
      batch = [];
      bytes = 16;
    };
    for (const object of objects) {
      const size = Buffer.byteLength(JSON.stringify(object)) + 1;
      if (size > budget)
        throw new AgentRuntimeError(
          "History entity exceeds the control frame budget; blob storage is required.",
          "HISTORY_ENTITY_TOO_LARGE",
          413,
        );
      if (batch.length >= 256 || bytes + size > budget) await flush();
      batch.push(object);
      bytes += size;
    }
    await flush();
  }
  async persistStreamHistory(
    sessionId: string,
    chunks: AgentRunStreamChunk[],
    outboxThrough?: number,
  ): Promise<void> {
    const objects: Array<{
      kind: string;
      value: unknown;
    }> = [];
    const add = (kind: string, value: unknown) => {
      if (!value || typeof value !== "object") return;
      const record = value as {
        id?: unknown;
        sessionId?: unknown;
      };
      if (
        typeof record.id !== "string" ||
        (record.sessionId !== undefined && record.sessionId !== sessionId)
      )
        return;
      objects.push({ kind, value });
    };
    for (const chunk of chunks) {
      switch (chunk.type) {
        case "run_started":
        case "run_activated":
        case "run_finished":
        case "run_completed":
        case "run_failed":
        case "run_resumed":
          add("runtime.run", chunk.run);
          break;
        case "step_started":
          add("runtime.step", chunk.step);
          break;
        case "message":
        case "input_injected":
          add("runtime.message", chunk.message);
          break;
        case "tool_call":
        case "tool_result":
        case "permission_requested":
          add("runtime.tool_call", chunk.toolCall);
          break;
        case "event":
          add("runtime.event", chunk.event);
          break;
        default:
          break;
      }
    }
    try {
      await this.appendHistoryEntities(sessionId, objects);
      if (outboxThrough !== undefined) {
        await this.historyCommand({
          sessionId,
          requestId: `history-outbox-ack:${sessionId}:${outboxThrough}`,
          operation: "ack_history_outbox",
          payload: { through: outboxThrough },
        });
      }
    } catch (error) {
      // HotStore is the durable event source. If the separate history commit
      // failed, ask the Rust sidecar to rebuild canonical history from its
      // retained hot stream before surfacing the failure.
      try {
        await this.historyCommand({
          sessionId,
          requestId: `history-reconcile:${sessionId}:${createHash("sha256").update(JSON.stringify(objects)).digest("hex")}`,
          operation: "reconcile_stream",
          payload: {},
        });
        return;
      } catch {
        throw error;
      }
    }
  }
  async persistHistoryObject(
    sessionId: string,
    kind: string,
    value: unknown,
  ): Promise<void> {
    if (!value || typeof value !== "object") return;
    if (
      typeof (
        value as {
          id?: unknown;
        }
      ).id !== "string"
    )
      return;
    const write = this.appendHistoryEntities(sessionId, [{ kind, value }]);
    let pending = this.pendingHistoryWrites.get(sessionId);
    if (!pending) {
      pending = new Set();
      this.pendingHistoryWrites.set(sessionId, pending);
    }
    pending.add(write);
    try {
      await write;
    } finally {
      pending.delete(write);
      if (!pending.size) this.pendingHistoryWrites.delete(sessionId);
    }
  }
  async flushHistoryWrites(sessionId: string): Promise<void> {
    await agentRuntimeStore.flushSession(sessionId);
    const pending = this.pendingHistoryWrites.get(sessionId);
    if (!pending?.size) return;
    await Promise.all([...pending]);
  }
  async listRunHistory(sessionId: string): Promise<unknown[]> {
    return this.listHistoryObjects(sessionId, 'list_runs');
  }
  async listMessageHistory(sessionId: string): Promise<unknown[]> {
    return this.listHistoryObjects(sessionId, 'list_messages');
  }
  async listSessionProjection(): Promise<unknown[]> {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    return readSessionList(client);
  }
  async importUiProjection(
    sessionId: string,
    snapshot: unknown,
  ): Promise<unknown> {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    const bytes = await client.importProjection(
      sessionId,
      new TextEncoder().encode(JSON.stringify(snapshot)),
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  async listHistoryObjects(
    sessionId: string,
    operation:
      | "list_runs"
      | "list_messages"
      | "list_steps"
      | "list_parts"
      | "list_tool_calls"
      | "list_events"
      | "list_artifacts"
      | "list_plans"
      | "list_work"
      | "list_contexts"
      | "list_aux_usage"
      | "list_permissions"
      | "list_interactions",
  ): Promise<unknown[]> {
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    return readHistoryList(client, sessionId, operation);
  }
  async persistTerminalInfo(
    projectId: string,
    terminal: Record<string, unknown>,
    outputTail = "",
    outputSequence = 0,
  ): Promise<void> {
    const scopeId = `terminals:${projectId}`;
    await this.historyCommandGlobal({
      scopeId,
      requestId: `terminal:${terminal.id}:${terminal.state}:${terminal.endedAt ?? "active"}`,
      operation: "append_entities",
      payload: {
        objects: [
          {
            kind: "runtime.terminal",
            value: {
              ...terminal,
              outputTail,
              outputSequence,
              sessionId: scopeId,
            },
          },
        ],
      },
    });
  }
  async listTerminalHistory(projectId: string): Promise<unknown[]> {
    const scopeId = `terminals:${projectId}`;
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    return readHistoryList(client, scopeId, 'list_terminals', { global: true });
  }
  async sessionStatsAuthoritative(
    sessionId: string,
    configuredContextLimit?: number | null,
  ): Promise<Record<string, unknown>> {
    const [snapshot, allSessions] = await Promise.all([
      this.uiSnapshotAuthoritative(sessionId),
      this.listSessionProjection(),
    ]);
    const session = snapshot.session as AgentSession;
    const projections = allSessions as AgentSession[];
    const tree = new Set<string>([sessionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of projections) {
        if (
          candidate.parentSessionId &&
          tree.has(candidate.parentSessionId) &&
          !tree.has(candidate.id)
        ) {
          tree.add(candidate.id);
          changed = true;
        }
      }
    }
    const records = await Promise.all(
      [...tree].map(async (id) => {
        const [runs, steps, tools, work, auxiliary] = await Promise.all([
          this.listHistoryObjects(id, "list_runs"),
          this.listHistoryObjects(id, "list_steps"),
          this.listHistoryObjects(id, "list_tool_calls"),
          this.listHistoryObjects(id, "list_work"),
          this.listHistoryObjects(id, "list_aux_usage"),
        ]);
        return {
          id,
          runs: runs as AgentRun[],
          steps: steps as AgentRunStep[],
          tools: tools as ToolCallRecord[],
          work,
          auxiliary,
        };
      }),
    );
    const root = records.find((item) => item.id === sessionId) ?? {
      id: sessionId,
      runs: [],
      steps: [],
      tools: [],
      work: [],
      auxiliary: [],
    };
    const zeroTotals = () => ({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cacheReadMatched: 0,
      cacheInputMatched: 0,
      cacheReadRatio: null,
    });
    const zeroCoverage = () => ({
      requests: 0,
      recorded: 0,
      missing: 0,
      complete: true,
      cacheReadKnown: 0,
      cacheReadUnknown: 0,
      cacheWriteKnown: 0,
      cacheWriteUnknown: 0,
      cacheMatched: 0,
    });
    const usage = {
      self: zeroTotals(),
      tree: zeroTotals(),
      steps: { self: zeroTotals(), tree: zeroTotals() },
      auxiliary: { self: zeroTotals(), tree: zeroTotals() },
    };
    const coverage = {
      self: zeroCoverage(),
      tree: zeroCoverage(),
      steps: { self: zeroCoverage(), tree: zeroCoverage() },
      auxiliary: { self: zeroCoverage(), tree: zeroCoverage() },
    };
    let contextInput: number | null = null;
    let contextMeasuredAt: string | null = null;
    let contextRequestId: string | null = null;
    let reportedWindow: number | null = null;
    let runningDuration = 0;
    const addStep = (step: AgentRunStep, isSelf: boolean) => {
      const metadata =
        step.metadata && typeof step.metadata === "object"
          ? (step.metadata as Record<string, unknown>)
          : {};
      const normalized = normalizeUsage(metadata.usage);
      const groups = isSelf ? (["self", "tree"] as const) : (["tree"] as const);
      for (const group of groups) {
        const target = usage.steps[group];
        const targetCoverage = coverage.steps[group];
        targetCoverage.requests++;
        if (normalized?.normalization.input.status === "known")
          targetCoverage.recorded++;
        else {
          targetCoverage.missing++;
          targetCoverage.complete = false;
        }
        target.input += normalized?.normalization.input.value ?? 0;
        target.output += normalized?.normalization.output.value ?? 0;
        target.reasoning += normalized?.normalization.reasoning.value ?? 0;
        target.cacheRead += normalized?.normalization.cacheRead.value ?? 0;
        target.cacheWrite += normalized?.normalization.cacheWrite.value ?? 0;
        target.total = target.input + target.output;
      }
      if (isSelf && normalized?.normalization.input.status === "known") {
        contextInput = normalized.normalization.input.value ?? null;
        contextRequestId =
          typeof normalized.requestId === "string"
            ? normalized.requestId
            : step.id;
        contextMeasuredAt =
          typeof normalized.measuredAt === "string"
            ? normalized.measuredAt
            : (step.completedAt ?? step.startedAt);
      }
      const start = Date.parse(step.startedAt);
      const run = root.runs.find((item) => item.id === step.runId);
      const end = step.completedAt ?? run?.completedAt;
      runningDuration +=
        Math.max(0, (end ? Date.parse(end) : Date.now()) - start) || 0;
      const candidateWindow = metadata.contextLimit;
      if (
        typeof candidateWindow === "number" &&
        Number.isFinite(candidateWindow)
      )
        reportedWindow = candidateWindow;
    };
    for (const record of records)
      for (const step of record.steps) addStep(step, record.id === sessionId);
    for (const record of records) {
      for (const item of record.auxiliary as Array<{
        sessionId?: unknown;
        usage?: unknown;
      }>) {
        const normalized = normalizeUsage(item.usage);
        for (const group of record.id === sessionId
          ? (["self", "tree"] as const)
          : (["tree"] as const)) {
          const target = usage.auxiliary[group];
          const targetCoverage = coverage.auxiliary[group];
          targetCoverage.requests++;
          if (normalized?.normalization.input.status === "known")
            targetCoverage.recorded++;
          else {
            targetCoverage.missing++;
            targetCoverage.complete = false;
          }
          target.input += normalized?.normalization.input.value ?? 0;
          target.output += normalized?.normalization.output.value ?? 0;
          target.reasoning += normalized?.normalization.reasoning.value ?? 0;
          target.cacheRead += normalized?.normalization.cacheRead.value ?? 0;
          target.cacheWrite += normalized?.normalization.cacheWrite.value ?? 0;
          target.total = target.input + target.output;
        }
      }
    }
    const currentWork = (
      root.work as Array<{
        id?: unknown;
        sessionId?: unknown;
        updatedAt?: unknown;
        status?: unknown;
        remaining?: unknown;
        reason?: unknown;
      }>
    )
      .filter(
        (item) =>
          item.sessionId === sessionId &&
          (!session.sessionMetadata?.activeWorkId ||
            item.id === session.sessionMetadata.activeWorkId),
      )
      .sort((a, b) =>
        String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
      )[0];
    const completedRuns = root.runs.filter((run) => run.status === "completed");
    const averageSteps = completedRuns.length
      ? completedRuns.reduce(
          (sum, run) =>
            sum + root.steps.filter((step) => step.runId === run.id).length,
          0,
        ) / completedRuns.length
      : null;
    const input = contextInput ?? 0;
    const contextLimit =
      typeof configuredContextLimit === "number" && configuredContextLimit > 0
        ? configuredContextLimit
        : (reportedWindow ?? 200000);
    return {
      work:
        currentWork && typeof currentWork.id === "string"
          ? {
              id: currentWork.id,
              status: String(currentWork.status ?? "active"),
              remaining: Array.isArray(currentWork.remaining)
                ? currentWork.remaining
                : [],
              reason:
                typeof currentWork.reason === "string"
                  ? currentWork.reason
                  : null,
            }
          : null,
      roundCount: root.steps.length,
      averageStepsPerCompletedRun: averageSteps,
      contextComposition: null,
      context: {
        inputTokens: contextInput,
        source: contextInput === null ? null : "provider",
        stale: false,
        requestId: contextRequestId,
        measuredAt: contextMeasuredAt,
        latestRequestUsageAvailable: contextInput !== null,
      },
      cache: projectCacheUsage([]),
      usage,
      coverage,
      tokenUsage: { input, output: usage.self.output, total: input },
      contextLimit,
      contextLimitKnown:
        contextInput !== null ||
        reportedWindow !== null ||
        configuredContextLimit != null,
      contextUsedPercent: Math.min(
        Math.round((input / contextLimit) * 100),
        100,
      ),
      toolCallCount: root.tools.length,
      runningDuration,
      status: session.status,
      activeSubAgentCount: projections.filter(
        (item) =>
          item.parentSessionId === sessionId && item.status === "running",
      ).length,
    };
  }
  async listHistoryCheckpoints(sessionId: string): Promise<
    Array<{
      id: string;
      objectId: string;
      metadata: Record<string, unknown>;
    }>
  > {
    const state = (await this.historyCommand({
      sessionId,
      requestId: historyReadRequest("list-checkpoints", sessionId),
      operation: "list_checkpoints",
      payload: {},
    })) as {
      items?: Array<{
        id?: unknown;
        objectId?: unknown;
        metadata?: unknown;
      }>;
    };
    return (state.items ?? []).flatMap((item) => {
      if (typeof item.id !== "string" || typeof item.objectId !== "string")
        return [];
      return [
        {
          id: item.id,
          objectId: item.objectId,
          metadata:
            item.metadata && typeof item.metadata === "object"
              ? (item.metadata as Record<string, unknown>)
              : {},
        },
      ];
    });
  }
  async previewHistoryAuthoritative(
    sessionId: string,
    checkpointId: string,
    includeFiles = true,
  ): Promise<{
    checkpointId: string;
    revision: number;
    removedMessages: number;
    files: [];
    conflicts: [];
    canApply: boolean;
    warnings: string[];
    preservedFiles: [];
    exclusions: string;
  }> {
    const [head, checkpoints, messages] = await Promise.all([
      this.historyHeadAuthoritative(sessionId),
      this.listHistoryCheckpoints(sessionId),
      this.listMessageHistory(sessionId) as Promise<AgentRuntimeMessage[]>,
    ]);
    const checkpoint = checkpoints.find((item) => item.id === checkpointId);
    if (!checkpoint)
      throw new AgentRuntimeError(
        "History checkpoint was not found.",
        "CHECKPOINT_NOT_FOUND",
        404,
      );
    const index = messages.findIndex(
      (item) => item.id === checkpoint.metadata.messageId,
    );
    if (index < 0)
      throw new AgentRuntimeError(
        "History checkpoint message was not found.",
        "CHECKPOINT_NOT_FOUND",
        404,
      );
    return {
      checkpointId,
      revision: head.revision,
      removedMessages: Math.max(0, messages.length - index - 1),
      files: [],
      conflicts: [],
      canApply: true,
      warnings: [
        "Rust history mutation changes the immutable conversation head.",
        ...(includeFiles
          ? [
              "Workspace files are preserved; file rollback is not part of the runtime history command.",
            ]
          : []),
      ],
      preservedFiles: [],
      exclusions: "Conversation history only; workspace files are not changed.",
    };
  }
  private async writeHistoryRootRefs(
    sessionId: string,
    refs: string[],
    requestPrefix: string,
  ): Promise<string> {
    let current = refs;
    let part = 0;
    while (current.length > 256) {
      const next: string[] = [];
      for (let offset = 0; offset < current.length; offset += 256) {
        const chunk = current.slice(offset, offset + 256);
        const result = (await this.historyCommand({
          sessionId,
          requestId: `${requestPrefix}:chunk:${part++}:${createHash("sha256").update(chunk.join("\0")).digest("hex")}`,
          operation: "put_object",
          payload: {
            kind: "runtime.session.root.chunk",
            value: { sessionId, count: chunk.length },
            refs: chunk,
          },
        })) as {
          objectId?: string;
        };
        if (!result.objectId)
          throw new Error(
            "runtime-history root chunk did not return an object id",
          );
        next.push(result.objectId);
      }
      current = next;
    }
    const result = (await this.historyCommand({
      sessionId,
      requestId: `${requestPrefix}:root:${createHash("sha256").update(current.join("\0")).digest("hex")}`,
      operation: "put_object",
      payload: {
        kind: "runtime.session.root",
        value: {
          sessionId,
          objectCount: refs.length,
          updatedAt: new Date().toISOString(),
        },
        refs: current,
      },
    })) as {
      objectId?: string;
    };
    if (!result.objectId)
      throw new Error("runtime-history root did not return an object id");
    return result.objectId;
  }
  private async writeHistoryRoot(
    sessionId: string,
    objects: Array<{
      kind: string;
      value: unknown;
    }>,
    requestPrefix: string,
  ): Promise<string> {
    const refs: string[] = [];
    for (const object of objects) {
      const result = (await this.historyCommand({
        sessionId,
        requestId: `${requestPrefix}:${object.kind}:${createHash("sha256").update(JSON.stringify(object.value)).digest("hex")}`,
        operation: "put_object",
        payload: object,
      })) as {
        objectId?: string;
      };
      if (!result.objectId)
        throw new Error("runtime-history object did not return an object id");
      refs.push(result.objectId);
    }
    return this.writeHistoryRootRefs(sessionId, refs, requestPrefix);
  }
  async applyHistoryAuthoritative(input: {
    sessionId: string;
    checkpointId: string;
    revision: number;
    requestId: string;
    action: "rollback" | "edit";
    message?: string;
  }): Promise<{
    sessionId: string;
    revision: number;
    input?: {
      message: string;
    };
  }> {
    const [head, checkpoints, messages, runs, steps, parts, tools, events] =
      await Promise.all([
        this.historyHeadAuthoritative(input.sessionId),
        this.listHistoryCheckpoints(input.sessionId),
        this.listHistoryObjects(input.sessionId, "list_messages"),
        this.listHistoryObjects(input.sessionId, "list_runs"),
        this.listHistoryObjects(input.sessionId, "list_steps"),
        this.listHistoryObjects(input.sessionId, "list_parts"),
        this.listHistoryObjects(input.sessionId, "list_tool_calls"),
        this.listHistoryObjects(input.sessionId, "list_events"),
      ]);
    if (head.revision !== input.revision)
      throw new AgentRuntimeError(
        "Conversation changed. Refresh history.",
        "HISTORY_STALE",
        409,
      );
    const checkpoint = checkpoints.find(
      (item) => item.id === input.checkpointId,
    );
    if (!checkpoint)
      throw new AgentRuntimeError(
        "History checkpoint was not found.",
        "CHECKPOINT_NOT_FOUND",
        404,
      );
    const orderedMessages = this.orderedHistory(
      messages as AgentRuntimeMessage[],
    );
    const boundary = orderedMessages.findIndex(
      (item) => item.id === checkpoint.metadata.messageId,
    );
    if (boundary < 0)
      throw new AgentRuntimeError(
        "History checkpoint message was not found.",
        "CHECKPOINT_NOT_FOUND",
        404,
      );
    const keptMessages = orderedMessages.slice(0, boundary + 1);
    const keptIds = new Set(keptMessages.map((item) => item.id));
    const runIds = new Set(
      keptMessages
        .map((item) => item.runId)
        .filter((id): id is string => Boolean(id)),
    );
    const keptRuns = (runs as AgentRun[]).filter((run) => runIds.has(run.id));
    const keptSteps = (steps as AgentRunStep[]).filter((step) =>
      runIds.has(step.runId),
    );
    const keptStepIds = new Set(keptSteps.map((step) => step.id));
    const objects: Array<{
      kind: string;
      value: unknown;
    }> = [
      ...keptMessages.map((value) => ({ kind: "runtime.message", value })),
      ...keptRuns.map((value) => ({ kind: "runtime.run", value })),
      ...keptSteps.map((value) => ({ kind: "runtime.step", value })),
      ...(
        parts as Array<{
          stepId?: string;
        }>
      )
        .filter((part) => part.stepId && keptStepIds.has(part.stepId))
        .map((value) => ({ kind: "runtime.part", value })),
      ...(
        tools as Array<{
          stepId?: string;
        }>
      )
        .filter((tool) => tool.stepId && keptStepIds.has(tool.stepId))
        .map((value) => ({ kind: "runtime.tool_call", value })),
      ...(
        events as Array<{
          runId?: string;
        }>
      )
        .filter((event) => !event.runId || runIds.has(event.runId))
        .map((value) => ({ kind: "runtime.event", value })),
    ];
    const root = await this.writeHistoryRoot(
      input.sessionId,
      objects,
      `history-mutation:${input.requestId}`,
    );
    const switched = (await this.historyCommand({
      sessionId: input.sessionId,
      requestId: `history-head:${input.requestId}`,
      operation: "head_switch",
      payload: { objectId: root, expectedRevision: input.revision },
    })) as {
      revision?: number;
    };
    return {
      sessionId: input.sessionId,
      revision: Number(switched.revision ?? input.revision + 1),
      ...(input.action === "edit" && input.message
        ? { input: { message: input.message } }
        : {}),
    };
  }
  async cloneHistoryAuthoritative(input: {
    sourceSessionId: string;
    targetSessionId: string;
    checkpointId: string;
    revision: number;
    requestId: string;
  }): Promise<{
    revision: number;
    objectCount: number;
  }> {
    const [head, checkpoints, messages, runs, steps, parts, tools, events] =
      await Promise.all([
        this.historyHeadAuthoritative(input.sourceSessionId),
        this.listHistoryCheckpoints(input.sourceSessionId),
        this.listHistoryObjects(input.sourceSessionId, "list_messages"),
        this.listHistoryObjects(input.sourceSessionId, "list_runs"),
        this.listHistoryObjects(input.sourceSessionId, "list_steps"),
        this.listHistoryObjects(input.sourceSessionId, "list_parts"),
        this.listHistoryObjects(input.sourceSessionId, "list_tool_calls"),
        this.listHistoryObjects(input.sourceSessionId, "list_events"),
      ]);
    if (head.revision !== input.revision)
      throw new AgentRuntimeError(
        "Conversation changed. Refresh the fork preview.",
        "HISTORY_STALE",
        409,
      );
    const checkpoint = checkpoints.find(
      (item) => item.id === input.checkpointId,
    );
    if (!checkpoint)
      throw new AgentRuntimeError(
        "History checkpoint was not found.",
        "CHECKPOINT_NOT_FOUND",
        404,
      );
    const orderedMessages = this.orderedHistory(
      messages as AgentRuntimeMessage[],
    );
    const boundary = orderedMessages.findIndex(
      (item) => item.id === checkpoint.metadata.messageId,
    );
    if (boundary < 0)
      throw new AgentRuntimeError(
        "History checkpoint message was not found.",
        "CHECKPOINT_NOT_FOUND",
        404,
      );
    const keepMessages = orderedMessages.slice(0, boundary + 1);
    const runIds = new Set(
      keepMessages
        .map((item) => item.runId)
        .filter((id): id is string => Boolean(id)),
    );
    const keepRuns = (runs as AgentRun[]).filter((run) => runIds.has(run.id));
    const keepSteps = (steps as AgentRunStep[]).filter((step) =>
      runIds.has(step.runId),
    );
    const stepIds = new Set(keepSteps.map((step) => step.id));
    const keepParts = (
      parts as Array<{
        stepId?: string;
      }>
    ).filter((part) => part.stepId && stepIds.has(part.stepId));
    const keepTools = (
      tools as Array<{
        stepId?: string;
      }>
    ).filter((tool) => tool.stepId && stepIds.has(tool.stepId));
    const keepEvents = (
      events as Array<{
        runId?: string;
      }>
    ).filter((event) => !event.runId || runIds.has(event.runId));
    const hashId = (kind: string, id: string) =>
      `fork_${createHash("sha256").update(`${input.requestId}:${kind}:${id}`).digest("hex").slice(0, 24)}`;
    const maps = new Map<string, string>();
    const remap = (kind: string, id: unknown): unknown => {
      if (typeof id !== "string") return id;
      const key = `${kind}:${id}`;
      const existing = maps.get(key);
      if (existing) return existing;
      const mapped = hashId(kind, id);
      maps.set(key, mapped);
      return mapped;
    };
    const transform = (kind: string, value: unknown): unknown => {
      const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
      if (typeof copy.id === "string") copy.id = remap(kind, copy.id);
      if ("sessionId" in copy) copy.sessionId = input.targetSessionId;
      if ("runId" in copy) copy.runId = remap("run", copy.runId);
      if ("stepId" in copy) copy.stepId = remap("step", copy.stepId);
      if ("toolCallId" in copy)
        copy.toolCallId = remap("tool", copy.toolCallId);
      if ("triggerMessageId" in copy)
        copy.triggerMessageId = remap("message", copy.triggerMessageId);
      if (copy.payload && typeof copy.payload === "object") {
        const payload = copy.payload as Record<string, unknown>;
        if (typeof payload.sessionId === "string")
          payload.sessionId = input.targetSessionId;
        if (typeof payload.runId === "string")
          payload.runId = remap("run", payload.runId);
      }
      return copy;
    };
    const objects: Array<{
      kind: string;
      value: unknown;
    }> = [
      ...keepMessages.map((value) => ({
        kind: "runtime.message",
        value: transform("message", value),
      })),
      ...keepRuns.map((value) => ({
        kind: "runtime.run",
        value: transform("run", value),
      })),
      ...keepSteps.map((value) => ({
        kind: "runtime.step",
        value: transform("step", value),
      })),
      ...keepParts.map((value) => ({
        kind: "runtime.part",
        value: transform("part", value),
      })),
      ...keepTools.map((value) => ({
        kind: "runtime.tool_call",
        value: transform("tool", value),
      })),
      ...keepEvents.map((value) => ({
        kind: "runtime.event",
        value: transform("event", value),
      })),
    ];
    const root = await this.writeHistoryRoot(
      input.targetSessionId,
      objects,
      `history-fork:${input.requestId}`,
    );
    const targetHead = await this.historyHeadAuthoritative(
      input.targetSessionId,
    );
    const switched = (await this.historyCommand({
      sessionId: input.targetSessionId,
      requestId: `history-fork-head:${input.requestId}`,
      operation: "head_switch",
      payload: { objectId: root, expectedRevision: targetHead.revision },
    })) as {
      revision?: number;
    };
    return {
      revision: Number(switched.revision ?? targetHead.revision + 1),
      objectCount: objects.length,
    };
  }
  async historyHeadAuthoritative(sessionId: string): Promise<{
    revision: number;
    objectId?: string;
  }> {
    return (await this.historyCommand({
      sessionId,
      requestId: historyReadRequest("head", sessionId),
      operation: "head_read",
      payload: {},
    })) as {
      revision: number;
      objectId?: string;
    };
  }
  private async historyHead(sessionId: string): Promise<{
    revision: number;
    objectId?: string;
  }> {
    return this.historyHeadAuthoritative(sessionId);
  }
  private orderedHistory<T>(items: T[]): T[] {
    return [...items].sort((left, right) => {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      const leftSequence = Number(
        leftRecord.sequence ?? leftRecord.index ?? Number.NaN,
      );
      const rightSequence = Number(
        rightRecord.sequence ?? rightRecord.index ?? Number.NaN,
      );
      if (
        Number.isSafeInteger(leftSequence) &&
        Number.isSafeInteger(rightSequence) &&
        leftSequence !== rightSequence
      )
        return leftSequence - rightSequence;
      const leftTime = String(
        leftRecord.createdAt ??
          leftRecord.startedAt ??
          leftRecord.timestamp ??
          "",
      );
      const rightTime = String(
        rightRecord.createdAt ??
          rightRecord.startedAt ??
          rightRecord.timestamp ??
          "",
      );
      return (
        leftTime.localeCompare(rightTime) ||
        String(leftRecord.id ?? "").localeCompare(String(rightRecord.id ?? ""))
      );
    });
  }
  private encodeGraphCursor(
    sessionId: string,
    revision: number,
    cursor: unknown,
  ): string {
    return Buffer.from(
      JSON.stringify({ sessionId, revision, cursor }),
    ).toString("base64url");
  }
  private decodeGraphCursor(
    sessionId: string,
    revision: number,
    cursor?: string,
  ): unknown | undefined {
    if (!cursor) return undefined;
    try {
      const value = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      ) as {
        sessionId?: unknown;
        revision?: unknown;
        cursor?: unknown;
      };
      if (
        value.sessionId !== sessionId ||
        value.revision !== revision ||
        !value.cursor
      )
        throw new Error("stale history cursor");
      return value.cursor;
    } catch {
      throw new AgentRuntimeError(
        "Conversation changed. Refresh history.",
        "HISTORY_STALE",
        409,
      );
    }
  }
  async historyEntityPageAuthoritative(
    sessionId: string,
    operation:
      | "list_messages"
      | "list_runs"
      | "list_steps"
      | "list_tool_calls"
      | "list_events",
    cursor?: string,
    limit = 256,
  ): Promise<{
    items: unknown[];
    cursor?: string;
    revision: number;
  }> {
    const head = await this.historyHeadAuthoritative(sessionId);
    const revision = Number.isSafeInteger(head.revision) ? head.revision : 0;
    if (!head.objectId) return { items: [], revision };
    const graphCursor = this.decodeGraphCursor(sessionId, revision, cursor);
    const page = (await this.historyCommand({
      sessionId,
      requestId: historyReadRequest(operation, sessionId),
      operation,
      payload: { cursor: graphCursor, limit, reverse: true },
    })) as {
      items?: unknown[];
      cursor?: unknown;
      revision: number;
    };
    return {
      items: page.items ?? [],
      revision: page.revision,
      ...(page.cursor
        ? { cursor: this.encodeGraphCursor(sessionId, page.revision, page.cursor) }
        : {}),
    };
  }
  async historyWindowAuthoritative(
    sessionId: string,
    cursor?: string,
  ): Promise<{
    messages: AgentRuntimeMessage[];
    runs: AgentRun[];
    steps: AgentRunStep[];
    toolCalls: ToolCallRecord[];
    events: RuntimeEvent[];
    permissions: unknown[];
    historyWindow: {
      revision: number;
      epoch: number;
      cursor?: string;
      olderCursor?: string;
      hasEarlier: boolean;
      latest: boolean;
      detailsTruncated: boolean;
    };
  }> {
    const [head, hot, runsRaw, stepsRaw, toolsRaw, eventsRaw] =
      await Promise.all([
        this.historyHead(sessionId),
        this.snapshotAuthoritative(sessionId),
        this.listHistoryObjects(sessionId, "list_runs"),
        this.listHistoryObjects(sessionId, "list_steps"),
        this.listHistoryObjects(sessionId, "list_tool_calls"),
        this.listHistoryObjects(sessionId, "list_events"),
      ]);
    const revision = Number.isSafeInteger(head.revision) ? head.revision : 0;
    const messagePage: AgentRuntimeMessage[] = [];
    let graphCursor = cursor;
    for (let page = 0; page < 32 && messagePage.length < 24; page++) {
      const result = await this.historyEntityPageAuthoritative(
        sessionId,
        "list_messages",
        graphCursor,
        24 - messagePage.length,
      );
      messagePage.push(...(result.items as AgentRuntimeMessage[]));
      if (!result.cursor) {
        graphCursor = undefined;
        break;
      }
      graphCursor = result.cursor;
    }
    const pageMessages = this.orderedHistory(messagePage).slice(-24);
    const stepIds = new Set(
      pageMessages
        .map((message) => message.stepId)
        .filter((id): id is string => Boolean(id)),
    );
    const runIds = new Set(
      pageMessages
        .map((message) => message.runId)
        .filter((id): id is string => Boolean(id)),
    );
    const steps = this.orderedHistory(
      (stepsRaw as AgentRunStep[]).filter(
        (step) => stepIds.has(step.id) || runIds.has(step.runId),
      ),
    ).slice(-48);
    for (const step of steps) runIds.add(step.runId);
    const runs = this.orderedHistory(
      (runsRaw as AgentRun[]).filter((run) => runIds.has(run.id)),
    ).slice(-48);
    const relatedStepIds = new Set(steps.map((step) => step.id));
    const toolCalls = this.orderedHistory(
      (toolsRaw as ToolCallRecord[]).filter(
        (tool) => tool.stepId && relatedStepIds.has(tool.stepId),
      ),
    ).slice(-96);
    const events = cursor
      ? []
      : this.orderedHistory(eventsRaw as RuntimeEvent[]).slice(-32);
    const permissions = cursor ? [] : (await this.listHistoryObjects(sessionId, 'list_permissions')).slice(-32);
    const epoch = hot?.epoch ?? 0;
    return {
      messages: pageMessages,
      runs,
      steps,
      toolCalls,
      events,
      permissions,
      historyWindow: {
        revision,
        epoch,
        cursor,
        olderCursor: graphCursor,
        hasEarlier: Boolean(graphCursor),
        latest: !cursor,
        detailsTruncated: false,
      },
    };
  }
  async historyTimelineAuthoritative(
    sessionId: string,
    before = Number.MAX_SAFE_INTEGER,
  ): Promise<{
    items: AgentRuntimeMessage[];
    next?: number;
    epoch: number;
  }> {
    const hot = await this.snapshotAuthoritative(sessionId);
    const messages: AgentRuntimeMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 32 && messages.length < 256; page++) {
      const result = await this.historyEntityPageAuthoritative(
        sessionId,
        "list_messages",
        cursor,
        256,
      );
      messages.push(
        ...(result.items as AgentRuntimeMessage[]).filter(
          (message) =>
            (message.role === "user" || message.role === "assistant") &&
            Number(
              (
                message as {
                  sequence?: unknown;
                }
              ).sequence ?? Number.MAX_SAFE_INTEGER,
            ) < before,
        ),
      );
      if (!result.cursor) break;
      cursor = result.cursor;
    }
    const ordered = this.orderedHistory(messages);
    const page = ordered.slice(-256);
    const next =
      ordered.length > page.length
        ? Number(
            (
              page[0] as
                | {
                    sequence?: unknown;
                  }
                | undefined
            )?.sequence,
          )
        : undefined;
    return {
      items: page,
      next: Number.isSafeInteger(next) ? next : undefined,
      epoch: hot?.epoch ?? 0,
    };
  }
  async messageContentAuthoritative(
    sessionId: string,
    messageId: string,
    cursor = 0,
    expectedRevision?: number,
  ): Promise<{
    text: string;
    next?: number;
    revision: number;
  }> {
    const head = await this.historyHead(sessionId);
    if (expectedRevision !== undefined && expectedRevision !== head.revision)
      throw new AgentRuntimeError(
        "Conversation changed.",
        "HISTORY_STALE",
        409,
      );
    if (cursor > 0 && expectedRevision === undefined)
      throw new AgentRuntimeError(
        "Content continuation requires the original revision.",
        "HISTORY_STALE",
        409,
      );
    let graphCursor: string | undefined;
    let message: AgentRuntimeMessage | undefined;
    for (let page = 0; page < 128 && !message; page++) {
      const result = await this.historyEntityPageAuthoritative(
        sessionId,
        "list_messages",
        graphCursor,
        256,
      );
      message = (result.items as AgentRuntimeMessage[]).find(
        (item) => item.id === messageId,
      );
      if (!result.cursor) break;
      graphCursor = result.cursor;
    }
    if (!message)
      throw new AgentRuntimeError("Message missing.", "NOT_FOUND", 404);
    const text = typeof message.content === "string" ? message.content : "";
    const pageSize = 8192;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length)
      throw new AgentRuntimeError(
        "Invalid content cursor.",
        "INVALID_INPUT",
        400,
      );
    return {
      text: text.slice(cursor, cursor + pageSize),
      next: cursor + pageSize < text.length ? cursor + pageSize : undefined,
      revision: head.revision,
    };
  }
  async uiSnapshotAuthoritative(sessionId: string): Promise<{
    session: AgentSession;
    run: AgentRun | null;
    cursor: number;
    liveChunks: AgentRunStreamChunk[];
    completedStepIds: string[];
    queuedInputs?: unknown[];
    forceInjectItemId?: string | null;
  }> {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    // Reads never seed from SQLite: a missing Rust projection requires explicit
    // session creation or offline migration, not an implicit authority switch.
    return decodeUiSnapshot(await client.uiSnapshot(sessionId), sessionId);
  }
  async uiTicket(sessionId: string, clientId: string) {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar discovery is not ready.");
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = Number(process.env.SYNAX_RUNTIME_SIDECAR_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("Runtime sidecar discovery is not ready.");
      const ticket = await client.issueTicket(sessionId, clientId);
      if (Number(process.env.SYNAX_RUNTIME_SIDECAR_PORT) !== port) continue;
      return {
        url: `ws://127.0.0.1:${port}/runtime`,
        token: ticket.token,
        expiresAtMs: ticket.expiresAtMs,
        clientId,
        sessionId,
        protocol: "synax.runtime.v2" as const,
      };
    }
    throw new Error("Runtime sidecar restarted during ticket issuance.");
  }
  async streamFence(
    sessionId: string,
    runId: string,
  ): Promise<{
    epoch: number;
    revision: number;
  }> {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    const snapshot = await client.snapshot(sessionId);
    if (snapshot.activeRunId !== runId)
      throw new Error("Runtime stream run is not active.");
    return { epoch: snapshot.epoch, revision: snapshot.revision };
  }
  async authoritativeRecordState(
    sessionId: string,
  ): Promise<RuntimeRecordState> {
    const snapshot = await this.uiSnapshotAuthoritative(sessionId);
    const session = snapshot.session;
    return {
      status: session.status,
      activeRunId: session.activeRunId,
      pendingResumeToken: session.pendingResumeToken,
      blockedReason: session.blockedReason,
      updatedAt: session.updatedAt,
    };
  }
  async appendStreamAuthoritative(input: RuntimeStreamInput): Promise<number> {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    const ack = await client.appendStream({
      sessionId: input.sessionId,
      runId: input.runId,
      producerId: input.producerId,
      producerSequence: input.producerSequence,
      epoch: input.epoch,
      revision: input.revision,
      durability: "group_commit",
      events: input.chunks.map((chunk) => ({
        kind:
          typeof chunk === "object" && chunk && "type" in chunk
            ? String(
                (
                  chunk as {
                    type: unknown;
                  }
                ).type,
              )
            : "runtime_chunk",
        payload: Buffer.from(
          JSON.stringify({ schema: 1, chunk, state: input.state }),
        ),
      })),
    });
    const match = /^stream:\d+-(\d+)$/.exec(ack.request);
    if (!match)
      throw new Error(
        "Runtime stream acknowledgement did not include a valid sequence range.",
      );
    return Number(match[1]);
  }
  async replayAuthoritative(
    sessionId: string,
    after: number,
    runId?: string,
  ): Promise<
    Array<{
      sequence: number;
      runId: string;
      payload: Uint8Array;
    }>
  > {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    const response = await client.replay(sessionId, after);
    return response.events
      .filter((event) => !runId || event.runId === runId)
      .map((event) => ({
        sequence: event.sequence,
        runId: event.runId,
        payload: event.payload,
      }));
  }
  async snapshotAuthoritative(sessionId: string) {
    const client = this.clientFactory();
    if (!client) throw new Error("Runtime sidecar client is not configured.");
    return await client.snapshot(sessionId);
  }
}
export const runtimeFacade = new RuntimeFacade();
