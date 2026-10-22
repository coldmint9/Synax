import type { ProviderEvent, ProviderRequest } from "./contracts.js";

/** Local IPC only. Provider HTTP, decoding, deadlines and retries belong to Rust. */
export async function* streamProvider(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  yield* nativeEvents<ProviderEvent>("/provider/stream", request, signal);
}

export async function prepareProvider(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderRequest> {
  for await (const event of nativeEvents<{ type: string; request: ProviderRequest }>("/provider/prepare", request, signal)) {
    if (event.type === "prepared") return event.request;
  }
  throw new Error("Native provider preparation returned no request.");
}

export async function* nativeEvents<T>(path: string, request: unknown, signal?: AbortSignal): AsyncGenerator<T> {
  const port = Number(process.env.SYNAX_RUNTIME_PROVIDER_PORT);
  const token = process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
  if (!Number.isInteger(port) || port <= 0 || !token) throw new Error("Rust provider bridge is not available.");
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: stringifyRustRequest(request), signal,
  });
  if (!response.ok) throw new Error(`Rust provider bridge returned HTTP ${response.status}: ${await response.text()}`);
  if (!response.body) throw new Error("Rust provider bridge returned no stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      pending += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (next.done && pending.trim()) { lines.push(pending); pending = ""; }
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "error") throw Object.assign(new Error(event.error ?? "Rust provider error"), {
          statusCode: event.statusCode, isRetryable: false,
        });
        yield event as T;
      }
      if (next.done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function stringifyRustRequest(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) return Buffer.from(item).toString("base64");
    if (item && typeof item === "object" && "type" in item && item.type === "Buffer" && "data" in item && Array.isArray(item.data))
      return Buffer.from(item.data).toString("base64");
    return item;
  });
}
