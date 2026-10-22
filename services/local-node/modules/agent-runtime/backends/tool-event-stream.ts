import type { AgentRunStreamChunk } from "../contracts.js";
import type { RustAgentLoopEvent } from "../rust-agent-loop-client.js";

export const PARALLEL_READ_TOOLS = new Set(["rg", "grep.search", "file.glob", "file.read", "file.list", "diff.read"]);
/** Only tools whose completed state lives in files/history can move to a new worker. */
export const WORKER_PORTABLE_TOOLS = new Set([...PARALLEL_READ_TOOLS, "file.write", "file.patch", "file.delete", "context.read"]);

/** Reads model events independently of a bounded set of independent read tools.
 * Other operations form an exclusive barrier. Progress is coalesced; completions
 * are never dropped and the source is only read one event ahead. */
export async function* toolEventStream(source: AsyncGenerator<RustAgentLoopEvent>, options: {
  execute: (event: RustAgentLoopEvent, emit: (chunk: AgentRunStreamChunk) => void) => Promise<void>;
  shouldStop: () => boolean;
  abort: () => void;
  concurrency?: number;
  progress?: { through: number };
  canParallel?: (event: RustAgentLoopEvent) => boolean;
}): AsyncGenerator<{ event: RustAgentLoopEvent } | { chunk: AgentRunStreamChunk }> {
  const active = new Set<Promise<void>>();
  const inFlight = new Set<number>();
  let consumed = options.progress?.through ?? 0;
  const acknowledge = () => { if (options.progress) options.progress.through = inFlight.size ? Math.min(consumed, ...[...inFlight].map(n => n - 1)) : consumed; };
  const chunks: AgentRunStreamChunk[] = [];
  let wake: (() => void) | undefined;
  let failure: unknown;
  let ended = false;
  let exclusive = false;
  let deferred: RustAgentLoopEvent | undefined;
  let next: Promise<{ result: IteratorResult<RustAgentLoopEvent> } | { error: unknown }> | undefined;
  const emit = (chunk: AgentRunStreamChunk) => {
    if (chunk.type === "tool_call") {
      const index = chunks.findIndex(item => item.type === "tool_call" && item.toolCall.id === chunk.toolCall.id);
      if (index >= 0) chunks[index] = chunk; else chunks.push(chunk);
    } else chunks.push(chunk);
    wake?.();
  };
  const launch = (event: RustAgentLoopEvent, read: boolean) => {
    exclusive = !read;
    if (event.sequence) inFlight.add(event.sequence);
    const job = options.execute(event, emit).catch(error => { failure = error; }).finally(() => {
      if (event.sequence) inFlight.delete(event.sequence); acknowledge();
      active.delete(job); if (!read) exclusive = false; wake?.();
    });
    active.add(job);
  };
  try {
    for (;;) {
      if (failure) throw failure;
      if (chunks.length) { yield { chunk: chunks.shift()! }; continue; }
      if (options.shouldStop() && active.size === 0) return;
      if (deferred && active.size === 0) { const event = deferred; deferred = undefined; launch(event, false); }
      if (ended && active.size === 0) return;
      if (!ended && !deferred && !exclusive && !next && active.size < (options.concurrency ?? 4)) {
        next = source.next().then(result => ({ result }), error => ({ error }));
      }
      const changed = new Promise<null>(resolve => { wake = () => resolve(null); });
      const ready = await (next ? Promise.race([next, changed]) : changed);
      wake = undefined;
      if (!ready) continue;
      next = undefined;
      if ("error" in ready) throw ready.error;
      if (ready.result.done) { ended = true; continue; }
      const event = ready.result.value;
      consumed = event.sequence ?? consumed;
      if (event.type !== "tool-call") { yield { event }; acknowledge(); continue; }
      const read = PARALLEL_READ_TOOLS.has(event.toolName ?? "") && (options.canParallel?.(event) ?? true);
      if (event.sequence) inFlight.add(event.sequence);
      acknowledge();
      if (!read && active.size > 0) deferred = event;
      else launch(event, read);
    }
  } finally {
    options.abort();
    await Promise.all(active);
    await next;
    await source.return(undefined as never);
  }
}
