import { getRawSqlite } from '../../db/index.js';
import { readUsageInputTokens, readUsageOutputTokens, readUsageContextWindowSize } from './acp-engine/acp-usage.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';

export interface UsageTotals { input: number; output: number; reasoning: number; cacheRead: number; total: number }
export interface UsageCoverage { requests: number; recorded: number; missing: number; complete: boolean }
export interface SessionUsageProjection {
  context: { inputTokens: number | null; requestId: string | null; measuredAt: string | null; latestRequestUsageAvailable: boolean };
  usage: { self: UsageTotals; tree: UsageTotals };
  coverage: { self: UsageCoverage; tree: UsageCoverage };
  durationMs: number;
  reportedWindow: number | null;
}
const zero = (): UsageTotals => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, total: 0 });
const number = (n: unknown): number => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
function parse(raw: string | null): Record<string, any> | null {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function hasUsage(u: Record<string, unknown> | null): boolean {
  return !!u && ['inputTokens', 'outputTokens', 'promptTokens', 'completionTokens', 'input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'totalTokens', 'total_tokens'].some(k => typeof u[k] === 'number');
}
export function projectSessionUsage(sessionId: string, treeIds: string[]): SessionUsageProjection {
  const ids = [...new Set([sessionId, ...treeIds])];
  const db = getRawSqlite();
  const slots = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT s.rowid AS sequence, s.id, s.session_id, s.started_at, s.completed_at, s.status, s.metadata_json, r.completed_at AS run_ended_at FROM agent_runtime_run_steps s JOIN agent_runtime_runs r ON r.id=s.run_id WHERE s.session_id IN (${slots}) ORDER BY s.started_at, s.rowid`).all(...ids) as Array<{ sequence: number; id: string; session_id: string; started_at: string; completed_at: string | null; run_ended_at: string | null; status: string; metadata_json: string }>;
  const auxiliary = db.prepare(`SELECT * FROM agent_runtime_aux_usage WHERE session_id IN (${slots})`).all(...ids) as Array<{ session_id: string; usage_json: string | null }>;
  const result: SessionUsageProjection = {
    context: { inputTokens: null, requestId: null, measuredAt: null, latestRequestUsageAvailable: false },
    usage: { self: zero(), tree: zero() },
    coverage: { self: { requests: 0, recorded: 0, missing: 0, complete: true }, tree: { requests: 0, recorded: 0, missing: 0, complete: true } },
    durationMs: 0, reportedWindow: null,
  };
  const add = (id: string, u: Record<string, any> | null) => {
    for (const group of id === sessionId ? ['self', 'tree'] as const : ['tree'] as const) {
      const coverage = result.coverage[group]; coverage.requests++;
      if (!hasUsage(u)) { coverage.missing++; coverage.complete = false; continue; }
      coverage.recorded++;
      const total = result.usage[group];
      total.input += readUsageInputTokens(u!); total.output += readUsageOutputTokens(u!);
      total.reasoning += number(u!.reasoningTokens ?? u!.thoughtTokens ?? u!.outputTokenDetails?.reasoningTokens ?? u!.completion_tokens_details?.reasoning_tokens ?? u!.raw?.completion_tokens_details?.reasoning_tokens);
      total.cacheRead += number(u!.cachedInputTokens ?? u!.cachedReadTokens ?? u!.inputTokenDetails?.cacheReadTokens ?? u!.prompt_cache_hit_tokens ?? u!.raw?.prompt_cache_hit_tokens);
      total.total = total.input + total.output;
    }
  };
  for (const row of rows) {
    const metadata = parse(row.metadata_json);
    const u = metadata?.usage ?? null;
    const contextUsage = metadata?.externalTurn ? metadata.contextUsage ?? null : u;
    add(row.session_id, u);
    if (row.session_id !== sessionId) continue;
    const start = Date.parse(row.started_at);
    const end = row.completed_at ?? row.run_ended_at;
    result.durationMs += Math.max(0, (end ? Date.parse(end) : ['running', 'waiting_permission', 'waiting_input'].includes(row.status) ? Date.now() : start) - start) || 0;
    result.context.latestRequestUsageAvailable = hasUsage(contextUsage);
    if (hasUsage(contextUsage)) {
      result.context.inputTokens = readUsageInputTokens(contextUsage!);
      result.context.requestId = contextUsage.requestId ?? row.id;
      result.context.measuredAt = contextUsage.measuredAt ?? row.completed_at ?? row.started_at;
      result.reportedWindow = readUsageContextWindowSize(contextUsage!) ?? result.reportedWindow;
    }
  }
  for (const row of auxiliary) add(row.session_id, parse(row.usage_json));
  return result;
}

/** Auxiliary calls have their own ID, never reuse a step ID or add their usage to step usage. */
export function startAuxUsage(sessionId: string, purpose: string, runId?: string | null): string {
  const id = makeRuntimeId('aux');
  getRawSqlite().prepare('INSERT INTO agent_runtime_aux_usage (id, session_id, run_id, purpose, started_at) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, runId ?? null, purpose, nowIso());
  return id;
}
export function finishAuxUsage(id: string, usage?: unknown): void {
  getRawSqlite().prepare('UPDATE agent_runtime_aux_usage SET completed_at=?, usage_json=? WHERE id=?').run(nowIso(), usage ? JSON.stringify(usage) : null, id);
}
