import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { stringifyRustRequest } from "../../infrastructure/llm-runtime/providers/rust-language-model.js";
import type { RuntimeExecutionContext } from "../../infrastructure/runtime/execution-context.js";

export type RustAgentLoopProviderRequest = {
  loopId?: string;
  requestId?: string;
  after?: number;
  resumeLoop?: boolean;
  apiFormat: string;
  providerId?: string;
  providerOptions?: Record<string, unknown>;
  temperature?: number;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  model: string;
  prompt: unknown[];
  tools?: unknown[];
  toolChoice?: unknown;
  maxOutputTokens?: number;
  maxSteps?: number;
  runtimeBinding?: { sessionId: string; runId: string };
  contextPolicy?: { contextLimit: number; outputReserve: number; keepRecentMessages?: number };
  executionContext?: RuntimeExecutionContext;
};

export type RustAgentLoopEvent = {
  type: string;
  loopId?: string;
  sequence?: number;
  step?: number;
  attempt?: number;
  contextId?: string;
  requestId?: string;
  startedAt?: string;
  composition?: import("./context-composition.js").ContextComposition;
  originalTokens?: number;
  compressedTokens?: number;
  messageCount?: number;
  summary?: string;
  chunk?: number;
  reason?: string;
  disposition?: { status: "completed" | "blocked" | "failed" | "interrupted"; reason: string; summary: string };
  message?: { role: string; content: unknown };
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  usage?: Record<string, unknown>;
  finishReason?: string;
  error?: string;
};

function endpoint(path: string): string {
  const port = Number(process.env.SYNAX_RUNTIME_PROVIDER_PORT);
  if (!Number.isInteger(port) || port <= 0)
    throw new Error("Rust agent loop bridge is not available.");
  return `http://127.0.0.1:${port}${path}`;
}

function authHeaders(): Record<string, string> {
  const token = process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
  if (!token) throw new Error("Rust agent loop bridge token is unavailable.");
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function bridgeRequest(path: string, options: RequestInit, signal?: AbortSignal): Promise<Response> {
  const deadline = Date.now() + 45_000;
  let attempt = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(endpoint(path), { ...options, signal });
      if (![502, 503, 504].includes(response.status)) {
        // Mutations have small JSON acknowledgements. Read the entire body
        // inside the retry boundary so a lost acknowledgement retries the
        // identical idempotency key instead of orphaning accepted execution.
        if (options.method === "POST") return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
        return response;
      }
      await response.body?.cancel();
      if (Date.now() >= deadline) throw new Error(`Rust bridge unavailable (${response.status}).`);
    } catch (error) {
      if (signal?.aborted || !(error instanceof TypeError) || Date.now() >= deadline) throw error;
    }
    await delay(Math.min(100 * 2 ** Math.min(attempt++, 4), 1000), undefined, { signal });
  }
}

async function resumeLoop(request: RustAgentLoopProviderRequest, loopId: string, signal?: AbortSignal) {
  const response = await bridgeRequest("/agent-loop/resume", {
    method: "POST", headers: authHeaders(), body: stringifyRustRequest({ ...request, loopId }),
  }, signal);
  if (!response.ok) throw new Error(`Rust agent loop resume failed (${response.status}): ${await response.text()}`);
}

export async function* streamRustAgentLoop(
  request: RustAgentLoopProviderRequest,
  signal?: AbortSignal,
  onStarted?: (loopId: string) => void | Promise<void>,
): AsyncGenerator<RustAgentLoopEvent> {
  const input = { ...request, requestId: request.requestId ?? randomUUID() };
  let loopId = request.loopId;
  if (!loopId) {
    const started = await bridgeRequest("/agent-loop/start", {
      method: "POST", headers: authHeaders(), body: stringifyRustRequest(input),
    }, signal);
    if (!started.ok) throw new Error(`Rust agent loop start failed (${started.status}): ${await started.text()}`);
    loopId = ((await started.json()) as { loopId?: string }).loopId;
  }
  if (!loopId) throw new Error("Rust agent loop did not return a loop ID.");
  await onStarted?.(loopId);
  const ownsExecution = !request.loopId || request.resumeLoop;
  let cursor = request.after ?? 0;
  let recoveryDeadline: number | undefined;
  for (;;) {
    signal?.throwIfAborted();
    if (ownsExecution) await resumeLoop(input, loopId, signal);
    const response = await bridgeRequest(`/agent-loop/events?loopId=${encodeURIComponent(loopId)}&after=${cursor}`, { headers: authHeaders() }, signal);
    if (!response.ok || !response.body) throw new Error(`Rust agent loop event stream failed (${response.status}).`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let disconnected = false;
    try {
      for (;;) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await reader.read(); }
        catch (error) { if (signal?.aborted) throw error; disconnected = true; break; }
        pending += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        if (next.done && pending.trim()) { lines.push(pending); pending = ""; }
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as RustAgentLoopEvent;
          if (!Number.isSafeInteger(event.sequence) || event.sequence! < 1) throw new Error("Rust event has no valid cursor.");
          if (event.sequence! <= cursor) continue;
          if (event.sequence !== cursor + 1) throw new Error("Rust event replay has a cursor gap.");
          yield event;
          cursor = event.sequence;
          recoveryDeadline = undefined;
          if (["done", "cancelled", "error"].includes(event.type)) return;
        }
        if (next.done) { disconnected = true; break; }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (!disconnected) throw new Error("Rust observation ended unexpectedly.");
    recoveryDeadline ??= Date.now() + 45_000;
    if (Date.now() >= recoveryDeadline) throw new Error("Rust event stream could not be recovered.");
    await delay(100, undefined, { signal });
  }
}

export async function sendRustAgentToolResult(input: {
  loopId: string;
  toolCallId: string;
  result: unknown;
  isError?: boolean;
  signal?: AbortSignal;
  executionContext?: RuntimeExecutionContext;
}): Promise<void> {
  const response = await bridgeRequest("/agent-loop/tool-result", {
    method: "POST",
    headers: authHeaders(),
    body: stringifyRustRequest({
      loopId: input.loopId,
      toolCallId: input.toolCallId,
      result: input.result,
      isError: input.isError ?? false,
      executionContext: input.executionContext,
    }),
  }, input.signal);
  if (!response.ok) throw new Error(`Rust agent loop tool result failed (${response.status}).`);
}

export async function cancelRustAgentLoop(loopId: string, signal?: AbortSignal): Promise<void> {
  const response = await bridgeRequest("/agent-loop/cancel", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ loopId }),
  }, signal);
  if (!response.ok && response.status !== 404)
    throw new Error(`Rust agent loop cancel failed (${response.status}).`);
}

export function rustLoopMessageId(): string {
  return `rust-loop-${randomUUID()}`;
}

export async function sendRustStepContext(input: {
  loopId: string; contextId: string; systemPrompt: string; tools: unknown[];
  executionContext?: RuntimeExecutionContext;
}, signal?: AbortSignal): Promise<void> {
  const response = await bridgeRequest("/agent-loop/context", {
    method: "POST", headers: authHeaders(), body: JSON.stringify(input),
  }, signal);
  if (!response.ok) throw new Error(`Rust step context rejected (${response.status}): ${await response.text()}`);
}
