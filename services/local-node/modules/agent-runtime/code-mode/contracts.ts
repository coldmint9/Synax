export const CODE_LIMITS = Object.freeze({
  timeoutMs: 15_000,
  memoryBytes: 32 * 1024 * 1024,
  maxCodeBytes: 32_000,
  maxCalls: 32,
  maxConcurrentCalls: 4,
  maxInputBytes: 32_000,
  maxToolResultBytes: 256_000,
  maxOutputBytes: 16_000,
  maxLogBytes: 4_000,
});
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
  /** Internal test/operator hook: may only lower the production ceilings. Never model input. */
  limits?: Partial<CodeLimits>;
}
