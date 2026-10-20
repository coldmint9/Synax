import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { startSidecar } from './node-sidecar.js';

export interface RuntimeConnectionRequest {
  sessionId: unknown;
  clientId: unknown;
  snapshot: unknown;
}

/** Called only after the main process validates the requesting frame. */
export function validateRuntimeConnectionRequest(input: RuntimeConnectionRequest): { sessionId: string; clientId: string; snapshot: boolean } {
  const { sessionId, clientId, snapshot } = input;
  if (typeof sessionId!== 'string' || sessionId.length < 1 || sessionId.length > 256 ||
      typeof clientId!== 'string' || clientId.length < 1 || clientId.length > 128 ||
      typeof snapshot!== 'boolean')
    throw new Error('Invalid runtime connection request.');
  return { sessionId, clientId, snapshot };
}

/** One disk read turns into two IPC answers; reopening windows must not add more. */
export class AccessTokenCache {
  private value: { text: string; mtimeMs: number; size: number } | null = null;
  private reading: Promise<string> | null = null;

  constructor(private readonly file: string) {}

  async read(): Promise<string> {
    const info = await stat(this.file).catch(() => null);
    if (!info) {
      this.value = null;
      throw new Error('Runtime access token is unavailable.');
    }
    if (this.value && this.value.mtimeMs === info.mtimeMs && this.value.size === info.size)
      return this.value.text;
    // Concurrent handshakes share one read instead of racing each other.
    this.reading ??= readFile(this.file, 'utf8').then((text) => {
      const trimmed = text.trim();
      this.value = { text: trimmed, mtimeMs: info.mtimeMs, size: info.size };
      return trimmed;
    }).finally(() => { this.reading = null; });
    return this.reading;
  }
}

export interface RuntimeConnectionOptions {
  port?: () => Promise<number>;
  tokenFile: string;
  tokens?: AccessTokenCache;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * fetch() validates the URL and may resolve DNS before it reads the body, and
 * both block the main event loop for the whole handshake. A loopback POST has
 * neither, so keep the reconnect path off the network stack the renderer uses.
 */
export async function fetchRuntimeTicket(
  input: { sessionId: string; clientId: string; snapshot: boolean },
  token: string,
  port: number,
  options: Pick<RuntimeConnectionOptions, 'fetch' | 'timeoutMs'> = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const response = await (options.fetch ?? fetch)(`http://127.0.0.1:${port}/api/agent-runtime/sessions/${encodeURIComponent(input.sessionId)}/runtime-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ clientId: input.clientId, snapshot: input.snapshot }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Runtime connection request failed (${response.status}).`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export class RuntimeConnectionBroker {
  private readonly tokens: AccessTokenCache;
  private inFlight: Promise<unknown> | null = null;
  private lastErrorAt = 0;

  constructor(private readonly options: RuntimeConnectionOptions) {
    this.tokens = options.tokens ?? new AccessTokenCache(options.tokenFile);
  }

  token(): Promise<string> {
    return this.tokens.read();
  }

  connection(input: RuntimeConnectionRequest): Promise<unknown> {
    const request = validateRuntimeConnectionRequest(input);
    // The renderer retries with its own backoff; do not turn that retry loop
    // into a burst of handshakes against a backend that is not answering.
    if (this.inFlight) return this.inFlight;
    if (this.lastErrorAt && Date.now() - this.lastErrorAt < 1_000)
      return Promise.reject(new Error('Runtime connection is backing off.'));
    const task = (async () => {
      const [port, token] = await Promise.all([(this.options.port ?? startSidecar)(), this.token()]);
      return await fetchRuntimeTicket(request, token, port, this.options);
    })().catch((error) => {
      this.lastErrorAt = Date.now();
      throw error;
    }).finally(() => { this.inFlight = null; });
    this.inFlight = task;
    return task;
  }
}

export function createRuntimeConnectionBroker(dataRoot: string): RuntimeConnectionBroker {
  return new RuntimeConnectionBroker({ tokenFile: path.join(dataRoot, 'runtime-access-token') });
}
