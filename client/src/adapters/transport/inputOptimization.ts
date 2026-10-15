import { apiFetch } from "./origin";

export interface InputOptimizationRequest {
  projectId: string;
  text: string;
  model?: string;
  backendId?: string;
}

export interface InputOptimizationResult {
  text: string;
  // Optional for compatibility with servers that only return text.
  status?: "optimized" | "unchanged" | "preserved";
}

export async function optimizeInput(
  input: InputOptimizationRequest,
  signal: AbortSignal,
  onDelta?: (text: string) => void,
): Promise<InputOptimizationResult> {
  const response = await apiFetch("/api/agent-runtime/input/optimize", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Input optimization failed (${response.status})`);
  }
  // Keep compatibility with older local runtimes.
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return response.json();
  if (!response.body) throw new Error("Input optimization stream is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = frame.split(/\r?\n/);
        const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === "error") throw new Error(payload.error);
        if (event === "delta" && typeof payload.text === "string") onDelta?.(payload.text);
        if (event === "result") {
          if (typeof payload.text !== "string") throw new Error("Invalid optimization result.");
          return payload;
        }
      }
      if (done) throw new Error("优化连接中断，原文已保留 / Optimization stream ended early; your draft was kept.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
