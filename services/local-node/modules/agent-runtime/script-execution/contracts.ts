import type { AsyncCommandResult } from "../tools/exec-async.js";

export type ScriptLanguage = "sh" | "python" | "node";

/** Source only: a cache hit never carries an approval or execution authority. */
export interface CachedScript {
  readonly scriptId: string;
  readonly language: ScriptLanguage;
  readonly source: string;
}

export interface MemoryCommandInput {
  /** Optional for low-level unit tests; registry callers always provide it. */
  sessionId?: string;
  argv?: string[];
  language?: "sh" | "node";
  source?: string;
  args?: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onStarted?: () => void;
}

export type { AsyncCommandResult };

export interface MemoryCommandResult extends AsyncCommandResult {
  sessionId: string;
  durationMs: number;
}
