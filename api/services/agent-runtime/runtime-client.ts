import type { RuntimeAsset, InputCapabilities, InputModality } from './content-parts.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AgentRun,
  AgentSession,
  CreateSessionRequest,
  PermissionDecision,
  PermissionReply,
  StreamTurnRequest,
  AgentRuntimeMessage,
} from './contracts.js';
import type { SessionInvocationUsageResponse } from './session-invocation-usage.js';
import {
  RUNTIME_PROTOCOL_VERSION,
  type ObserveRunOptions,
  type RuntimeBackendDescriptor,
  type RuntimeClient,
  type RuntimeClientOptions,
  type RuntimeErrorBody,
  type RuntimeEventEnvelope,
  type RuntimeInteraction,
  type RuntimeInteractionReply,
  type RuntimePermissionListResponse,
  type RuntimeRunStepListResponse,
  type RuntimeSessionListResponse,
  type RuntimeSessionPayload,
  type SubmitRunOptions,
  type RuntimeTransport,
} from './runtime-protocol.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'blocked']);

export class SynaxRuntimeError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; code?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SynaxRuntimeError';
    this.status = options.status ?? 500;
    this.code = options.code;
    this.details = options.details;
    this.retryable = this.status === 408 || this.status === 425 || this.status === 429 || this.status >= 500;
  }
}

function resolveToken(options: RuntimeClientOptions): string | undefined {
  if (options.token !== undefined) return options.token.trim() || undefined;
  if (!options.tokenFile && process.env.SYNAX_RUNTIME_TOKEN?.trim()) return process.env.SYNAX_RUNTIME_TOKEN.trim();
  const remote = new URL(options.baseUrl ?? process.env.SYNAX_API ?? 'http://127.0.0.1:3210');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(remote.hostname) && !options.tokenFile && !process.env.SYNAX_RUNTIME_TOKEN_FILE) return undefined;
  const tokenFile = options.tokenFile ?? process.env.SYNAX_RUNTIME_TOKEN_FILE ?? path.join(
    process.env.DATA_ROOT ?? path.join(os.homedir(), '.synax'),
    'runtime-access-token',
  );
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    return token || undefined;
  } catch (error) {
    if (options.tokenFile || process.env.SYNAX_RUNTIME_TOKEN_FILE) throw new SynaxRuntimeError('Cannot read the configured Runtime token file.', { status: 400, code: 'TOKEN_FILE_UNREADABLE', cause: error });
    return undefined;
  }
}

function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('Aborted')); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function encodeId(value: string): string {
  return encodeURIComponent(value);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}

interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
}

async function* readSse(response: Response, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  if (!response.body) throw new SynaxRuntimeError('Runtime returned an empty SSE body.', { status: 502 });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  const emit = (): SseFrame | null => {
    if (!id && !event && data.length === 0) return null;
    const frame = { id, event, data: data.length ? data.join('\n') : undefined };
    id = undefined;
    event = undefined;
    data = [];
    return frame;
  };

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          const frame = emit();
          if (frame) yield frame;
          continue;
        }
        if (line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator === -1 ? line : line.slice(0, separator);
        const valueText = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
        if (field === 'id') id = valueText;
        else if (field === 'event') event = valueText;
        else if (field === 'data') data.push(valueText);
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const lines = buffer.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('id:')) id = line.slice(3).replace(/^ /, '');
      }
    }
    const frame = emit();
    if (frame) yield frame;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function toEnvelope(
  sessionId: string,
  runId: string,
  sequence: number,
  payload: Record<string, unknown>,
): RuntimeEventEnvelope {
  return {
    protocol: RUNTIME_PROTOCOL_VERSION,
    sequence,
    sessionId,
    runId,
    type: typeof payload.type === 'string' ? payload.type : 'event',
    payload: payload as never,
  };
}

export class HttpRuntimeClient implements RuntimeClient {
  readonly baseUrl: string;
  readonly token?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly transport: RuntimeTransport;

  constructor(options: RuntimeClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.SYNAX_API ?? 'http://127.0.0.1:3210';
    this.token = resolveToken(options);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!this.fetchImpl) throw new SynaxRuntimeError('Global fetch is unavailable; use Node.js 22 or provide fetch.');
    this.transport = options.transport ?? { request: (input, init) => this.fetchImpl(input, init) };
  }

  private async request<T>(pathname: string, init: RequestInit = {}, options: { retry?: boolean } = {}): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const retry = options.retry ?? method === 'GET';
    let attempt = 0;
    for (;;) {
      try {
        const headers = new Headers(init.headers);
        headers.set('Accept', 'application/json');
        if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
        if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
        const response = await this.transport.request(joinUrl(this.baseUrl, pathname), { ...init, method, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs) });
        const text = await response.text();
        const body = parseJson(text);
        if (!response.ok) {
          const errorBody = (body && typeof body === 'object' ? body : {}) as Partial<RuntimeErrorBody>;
          const error = new SynaxRuntimeError(
            typeof errorBody.error === 'string' ? errorBody.error : `Runtime request failed (${method} ${pathname}): HTTP ${response.status}`,
            { status: response.status, code: errorBody.code, details: { response: errorBody.details, method, path: pathname } },
          );
          if (retry && error.retryable && attempt < this.maxRetries) {
            await wait(this.retryDelayMs * 2 ** attempt);
            attempt++;
            continue;
          }
          throw error;
        }
        return body as T;
      } catch (error) {
        if (error instanceof SynaxRuntimeError) {
          if (retry && error.retryable && attempt < this.maxRetries) {
            await wait(this.retryDelayMs * 2 ** attempt);
            attempt++;
            continue;
          }
          throw error;
        }
        if (retry && attempt < this.maxRetries) {
          await wait(this.retryDelayMs * 2 ** attempt);
          attempt++;
          continue;
        }
        throw new SynaxRuntimeError(error instanceof Error ? error.message : String(error), { cause: error });
      }
    }
  }

  health(): Promise<unknown> {
    return this.request('/api/health');
  }

  getProtocol(): Promise<{ protocol: string; schema?: unknown; transports?: string[]; operations?: string[] }> {
    return this.request('/api/agent-runtime/protocol');
  }

  listBackends(): Promise<{ items: RuntimeBackendDescriptor[] }> {
    return this.request('/api/agent-runtime/backends');
  }

  listBackendModels(id: string): Promise<{ models: Array<{ id: string; label: string; efforts?: string[]; inputModalities?: InputModality[] }>; defaultModel?: string | null }> {
    return this.request(`/api/agent-runtime/backends/${encodeId(id)}/models`);
  }

  listProjects(): Promise<{ items: Array<{ id: string; name: string; source?: { localPath?: string; kind?: string } }> }> {
    return this.request('/api/projects');
  }

  createProject(body: { name: string; environment?: 'production' | 'staging' | 'development'; source: { kind: 'localPath'; localPath: string } }): Promise<{ project: { id: string; name: string; source?: { localPath?: string; kind?: string } } }> {
    return this.request('/api/projects', { method: 'POST', body: JSON.stringify(body) }, { retry: false });
  }

  listSessions(query: Record<string, string | number | undefined> = {}): Promise<RuntimeSessionListResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return this.request(`/api/agent-runtime/sessions${params.size ? `?${params}` : ''}`);
  }

  createSession(body: CreateSessionRequest): Promise<RuntimeSessionPayload> {
    return this.request('/api/agent-runtime/sessions', { method: 'POST', body: JSON.stringify(body) }, { retry: false });
  }

  getSession(sessionId: string): Promise<RuntimeSessionPayload> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}`);
  }

  listRuns(sessionId: string): Promise<{ items: AgentRun[] }> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/runs`);
  }

  listMessages(sessionId: string): Promise<{ items: AgentRuntimeMessage[] }> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/messages`);
  }

  getSessionCapabilities(sessionId: string): Promise<{ backend?: RuntimeBackendDescriptor }> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/capabilities`);
  }

  getSessionInvocationUsage(sessionId: string): Promise<SessionInvocationUsageResponse> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/invocation-usage`);
  }

  uploadAsset(projectId: string, file: File, signal?: AbortSignal): Promise<{asset: RuntimeAsset}> {
    const body=new FormData();body.set('projectId',projectId);body.set('file',file);
    return this.request('/api/agent-runtime/assets',{method:'POST',body,signal},{retry:false});
  }
  getAsset(id:string):Promise<{asset:RuntimeAsset}>{return this.request(`/api/agent-runtime/assets/${encodeId(id)}`);}
  deleteAsset(id:string):Promise<{deleted:boolean}>{return this.request(`/api/agent-runtime/assets/${encodeId(id)}`,{method:'DELETE'});}
  getInputCapabilities(sessionId:string,model?:string):Promise<InputCapabilities>{return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/input-capabilities${model?`?model=${encodeURIComponent(model)}`:''}`);}
  async downloadAsset(id:string,signal?:AbortSignal):Promise<Blob>{
    const response=await this.transport.request(joinUrl(this.baseUrl,`/api/agent-runtime/assets/${encodeId(id)}/content`),{headers:this.token?{Authorization:`Bearer ${this.token}`}:{},redirect:'error',signal:signal??AbortSignal.timeout(this.requestTimeoutMs)});
    if(!response.ok)throw new SynaxRuntimeError('Unable to download media.',{status:response.status});return response.blob();
  }

  submitRun(sessionId: string, input: StreamTurnRequest, options: SubmitRunOptions): Promise<{ run: AgentRun; reused: boolean }> {
    const requestId = options.requestId || randomUUID();
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/runs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': requestId },
      body: JSON.stringify({ ...input, requestId, mode: options.mode ?? 'turn' }),
    }, { retry: false });
  }

  continueSession(sessionId: string, input: StreamTurnRequest, options: SubmitRunOptions): Promise<{ run: AgentRun; reused: boolean }> {
    return this.submitRun(sessionId, input, { ...options, mode: 'continue' });
  }

  private async *observeRunOnce(sessionId: string, runId: string, after: number, signal?: AbortSignal): AsyncGenerator<RuntimeEventEnvelope> {
    const headers = new Headers({ Accept: 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const response = await this.transport.request(joinUrl(this.baseUrl, `/api/agent-runtime/sessions/${encodeId(sessionId)}/runs/${encodeId(runId)}/stream?after=${after}`), { headers, signal, redirect: 'error' });
    if (!response.ok) {
      const body = parseJson(await response.text());
      const errorBody = (body && typeof body === 'object' ? body : {}) as Partial<RuntimeErrorBody>;
      throw new SynaxRuntimeError(typeof errorBody.error === 'string' ? errorBody.error : `Runtime stream failed (GET ${sessionId}/${runId}/stream): HTTP ${response.status}`, {
        status: response.status, code: errorBody.code, details: { response: errorBody.details, method: 'GET', path: `/api/agent-runtime/sessions/${sessionId}/runs/${runId}/stream` },
      });
    }
    for await (const frame of readSse(response, signal)) {
      if (frame.data === '[DONE]') return;
      if (!frame.data || frame.event === 'ping' || frame.event === 'connected') continue;
      const payload = parseJson(frame.data);
      const sequence = Number(frame.id);
      if (!payload || typeof payload !== 'object' || typeof (payload as Record<string, unknown>).type !== 'string' || frame.id === undefined || !Number.isSafeInteger(sequence) || sequence < 1) {
        throw new SynaxRuntimeError('Invalid Runtime stream envelope or sequence.', { status: 422, code: 'PROTOCOL_ERROR' });
      }
      yield toEnvelope(sessionId, runId, sequence, payload as Record<string, unknown>);
    }
  }

  async *observeRun(sessionId: string, runId: string, options: ObserveRunOptions = {}): AsyncGenerator<RuntimeEventEnvelope> {
    let cursor = options.after ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new SynaxRuntimeError('Invalid stream cursor.', { status: 400, code: 'INVALID_CURSOR' });
    let reconnectAttempts = 0;
    const reconnect = options.reconnect ?? true;
    const maxReconnectAttempts = options.maxReconnectAttempts ?? 8;
    for (;;) {
      try {
        let gotDone = false;
        for await (const envelope of this.observeRunOnce(sessionId, runId, cursor, options.signal)) {
          if (envelope.sequence <= cursor) continue;
          cursor = envelope.sequence;
          reconnectAttempts = 0;
          yield envelope;
          if (envelope.type === 'done') { gotDone = true; break; }
        }
        if (gotDone) return;
        const run = await this.getRun(sessionId, runId);
        if (TERMINAL_RUN_STATUSES.has(run.status) || !reconnect) return;
        if (options.signal?.aborted) return;
      } catch (error) {
        if (options.signal?.aborted || isAbortError(error)) return;
        if (!reconnect || reconnectAttempts >= maxReconnectAttempts || error instanceof SynaxRuntimeError && !error.retryable) throw error;
      }
      if (reconnectAttempts >= maxReconnectAttempts) throw new SynaxRuntimeError('Runtime observation did not make progress.', { code: 'STREAM_DISCONNECTED' });
      reconnectAttempts++;
      await wait(Math.min(4000, this.retryDelayMs * 2 ** Math.max(0, reconnectAttempts - 1)), options.signal);
    }
  }

  getRun(sessionId: string, runId: string): Promise<AgentRun> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/runs/${encodeId(runId)}`);
  }

  listRunSteps(sessionId: string, runId: string): Promise<RuntimeRunStepListResponse> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/runs/${encodeId(runId)}/steps`);
  }

  listPermissions(sessionId: string): Promise<RuntimePermissionListResponse> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/permissions`);
  }

  replyPermission(sessionId: string, permissionId: string, reply: PermissionReply, message?: string): Promise<PermissionDecision> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/permissions/${encodeId(permissionId)}/reply`, {
      method: 'POST', body: JSON.stringify({ reply, ...(message ? { message } : {}) }),
    }, { retry: false });
  }

  listInteractions(sessionId: string): Promise<{ interactions: RuntimeInteraction[] }> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/interactions`);
  }

  replyInteraction(sessionId: string, interactionId: string, reply: RuntimeInteractionReply): Promise<{ interaction: RuntimeInteraction }> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/interactions/${encodeId(interactionId)}/reply`, {
      method: 'POST', body: JSON.stringify(reply),
    }, { retry: false });
  }

  cancelSession(sessionId: string, runId?: string): Promise<AgentSession> {
    return this.request(`/api/agent-runtime/sessions/${encodeId(sessionId)}/cancel`, {
      method: 'POST', body: JSON.stringify(runId ? { runId } : {}),
    }, { retry: false });
  }
}

export function createSynaxClient(options: RuntimeClientOptions = {}): RuntimeClient {
  return new HttpRuntimeClient(options);
}
