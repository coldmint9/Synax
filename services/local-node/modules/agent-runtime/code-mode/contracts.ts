export const CODE_LIMITS = Object.freeze({
  queueTimeoutMs: 30_000,
  timeoutMs: 15_000,
  memoryBytes: 32 * 1024 * 1024,
  maxCodeBytes: 32_000,
  maxCalls: 32,
  maxConcurrentCalls: 4,
  maxInputBytes: 32_000,
  maxToolResultBytes: 256_000,
  // Storage/transport ceiling, independent of the model-context inline budget.
  maxOutputBytes: 1_000_000,
  maxLogBytes: 4_000,
});
export const CODE_WORKER_CAPACITY = Object.freeze({ active: 2, waiting: 16 });
export const CODE_WORKER_REUSE = Object.freeze({
  // Keep both slots warm during sustained concurrent use. Retaining one slot
  // makes every second batch create/terminate a thread and can cost more CPU
  // than the extra idle WASM heap.
  idle: CODE_WORKER_CAPACITY.active,
  idleTimeoutMs: 15_000,
  maxUses: 128,
  // The bundled WASM starts at 16 MiB. Do not keep an expanded heap warm.
  maxWasmBytes: 16 * 1024 * 1024,
});
export const CODE_INLINE_BYTES = 16_000;
export type CodeLimits = { [K in keyof typeof CODE_LIMITS]: number };
export type CodeStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "denied"
  | "unavailable";
export interface CodeResult {
  status: CodeStatus;
  value?: unknown;
  error?: string;
  stdout: string;
  truncated: boolean;
  /** Time waiting for worker admission; included in durationMs, not timeoutMs. */
  queueWaitMs: number;
  durationMs: number;
}
export interface ExecuteCodeInput {
  code: string;
  signal?: AbortSignal;
  callTool: (
    toolId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  /** Host policy only. Unclassified calls form an exclusive ordering barrier. */
  canParallelTool?: (toolId: string) => boolean;
  /** Internal test/operator hook: may only lower the production ceilings. Never model input. */
  limits?: Partial<CodeLimits>;
}
