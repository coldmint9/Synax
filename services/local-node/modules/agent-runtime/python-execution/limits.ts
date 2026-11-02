import {
  MAX_EXEC_TIMEOUT_MS,
  MIN_EXEC_TIMEOUT_MS,
  resolveExecTimeoutMs,
} from "../tools/command-timeout.js";

/** Hard bounds for python.run; the model-facing schema advertises the same values. */
export const MAX_CODE_CHARS = 100_000;
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Bytes kept per stream before the remainder is replaced by a truncation notice. */
export const MAX_STREAM_BYTES = 64_000;
/** Session-scoped sandbox directory below the runtime data root. */
export const SANDBOX_DIRECTORY = "python-sandbox";

export { MAX_EXEC_TIMEOUT_MS, MIN_EXEC_TIMEOUT_MS };

/** python.run keeps partial output on a timeout, so the window is bounded like a command. */
export function pythonRunTimeout(value?: number): number {
  return resolveExecTimeoutMs(value, DEFAULT_TIMEOUT_MS);
}
