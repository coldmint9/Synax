import { apiFetch } from "./origin";

export type CommitMessageStreamEvent =
  | { type: "delta"; text: string }
  | { type: "final"; message: string };

/** A generation is complete only after both a final message and the SSE sentinel. */
export async function streamCommitMessage(
  sessionId: string,
  input: { rootId?: string; model: string },
  onEvent: (event: CommitMessageStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await apiFetch(
    `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/git/commit-message/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    },
  );
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(error.error || `Generation failed (${response.status})`);
  }
  if (!response.body) throw new Error("No commit message stream returned.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final = false;
  let done = false;
  const consume = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      done = true;
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error("Invalid commit message stream response.");
    }
    if (!event || typeof event !== "object")
      throw new Error("Invalid commit message stream response.");
    const item = event as Record<string, unknown>;
    if (item.type === "error")
      throw new Error(
        typeof item.error === "string" ? item.error : "Generation failed.",
      );
    if (item.type === "delta" && typeof item.text === "string")
      onEvent({ type: "delta", text: item.text });
    else if (
      item.type === "final" &&
      typeof item.message === "string" &&
      item.message.trim()
    ) {
      final = true;
      onEvent({ type: "final", message: item.message });
    } else throw new Error("Invalid commit message stream response.");
  };
  try {
    while (!done) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      buffer = (buffer + decoder.decode(part.value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (done) break;
        boundary = buffer.indexOf("\n\n");
      }
    }
    signal.throwIfAborted();
    if (!done || !final) throw new Error("Incomplete commit message stream.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
