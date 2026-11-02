import type { AgentRun, AgentRuntimeMessage, ToolCallRecord } from "./contracts.js";
import type { AgentRuntimeStore } from "./session-store.js";
import { parseApplyPatchEnvelope } from "./tools/patch-format.js";
import { logger } from "../../infrastructure/runtime/logger.js";

/**
 * Structured facts about a child's own timeline, derived only from persisted
 * records. The delegating agent needs to know what already happened so it can
 * continue the work; it never needs a narrative. Every value here is copied
 * from a durable record (a run row, a tool call, a message) — nothing is
 * paraphrased, inferred or generated, so a failed child cannot smuggle a
 * plausible-sounding story into the parent's context.
 *
 * Samples are bounded: counts are exact, lists are capped, text is excerpted.
 */
export interface SubagentProgressFacts {
  /** Model turns the child actually started. */
  runs: number;
  lastRunStatus: string | null;
  tools: { total: number; completed: number; failed: number; blocked: number };
  /** Newest first; each entry is the persisted tool error, not a summary of it. */
  failedTools: Array<{ tool: string; error: string }>;
  /** Paths a successful write reported, deduped and bounded. */
  writtenPaths: string[];
  /** Last assistant text the child produced, flagged when the run was cut short. */
  lastText: { text: string; partial: boolean } | null;
}

export const SUBAGENT_FACT_FAILED_TOOLS = 5;
export const SUBAGENT_FACT_WRITE_PATHS = 20;
export const SUBAGENT_FACT_ERROR_CHARS = 200;
export const SUBAGENT_FACT_TEXT_CHARS = 400;

const SUCCEEDED = new Set(["completed", "compacted"]);
const FAILED = new Set(["failed", "denied"]);
const BLOCKED = new Set(["blocked", "cancelled"]);
const WRITE_TOOLS = new Set(["file.write", "file.delete", "file.patch"]);

type FactsSource = Pick<
  AgentRuntimeStore,
  "listRuns" | "listRunToolCalls" | "listMessages"
>;

const excerpt = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`;

function read<T>(work: () => T, fallback: T, childSessionId: string, label: string): T {
  try {
    return work();
  } catch (err) {
    // Facts are a projection for the parent, never a prerequisite for its
    // result: an unreadable source degrades the sample, it cannot fail the call.
    logger.warn(
      { childSessionId, source: label, err },
      "[subagent-progress-facts] source unavailable",
    );
    return fallback;
  }
}

function writtenPathsFrom(call: ToolCallRecord): string[] {
  const args = call.inputRef as { path?: unknown; patch?: unknown } | null;
  if (typeof args?.path === "string") return [args.path];
  if (call.toolId !== "file.patch" || typeof args?.patch !== "string") return [];
  try {
    return parseApplyPatchEnvelope(args.patch).flatMap((hunk) =>
      hunk.type === "update" && hunk.movePath ? [hunk.path, hunk.movePath] : [hunk.path],
    );
  } catch {
    // An unparseable patch never applied, so it contributes no write evidence.
    return [];
  }
}

/**
 * Project a child session into bounded facts. Returns null when there is
 * nothing durable to report, so a caller can omit the field instead of
 * shipping an empty object that reads like a finding.
 */
export function readSubagentProgressFacts(
  childSessionId: string,
  source: FactsSource,
): SubagentProgressFacts | null {
  const runs = read(() => source.listRuns(childSessionId), [] as AgentRun[], childSessionId, "runs");
  const calls: ToolCallRecord[] = [];
  for (const run of runs) {
    if (typeof run.id !== "string") continue;
    calls.push(...read(() => source.listRunToolCalls(run.id), [] as ToolCallRecord[], childSessionId, "toolCalls"));
  }
  const messages = read(
    () => source.listMessages(childSessionId),
    [] as AgentRuntimeMessage[],
    childSessionId,
    "messages",
  );
  // Runs come newest-first, so aggregate in real time order before sampling.
  calls.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));

  let completed = 0;
  let failed = 0;
  let blocked = 0;
  const failures: Array<{ tool: string; error: string }> = [];
  const paths = new Set<string>();
  for (const call of calls) {
    if (SUCCEEDED.has(call.status)) completed++;
    else if (FAILED.has(call.status)) failed++;
    else if (BLOCKED.has(call.status)) blocked++;
    if (FAILED.has(call.status) || BLOCKED.has(call.status))
      failures.push({
        tool: call.toolId,
        error: excerpt(call.error ?? call.outputSummary ?? call.status, SUBAGENT_FACT_ERROR_CHARS),
      });
    if (SUCCEEDED.has(call.status) && WRITE_TOOLS.has(call.toolId))
      for (const path of writtenPathsFrom(call)) paths.add(path);
  }

  let lastText: SubagentProgressFacts["lastText"] = null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.content.trim()) continue;
    lastText = {
      text: excerpt(message.content.trim(), SUBAGENT_FACT_TEXT_CHARS),
      partial: message.metadata?.partial === true,
    };
    break;
  }

  if (!runs.length && !calls.length && !lastText) return null;
  return {
    runs: runs.length,
    lastRunStatus: runs[0]?.status ?? null,
    tools: { total: calls.length, completed, failed, blocked },
    failedTools: failures.slice(-SUBAGENT_FACT_FAILED_TOOLS).reverse(),
    writtenPaths: [...paths].slice(0, SUBAGENT_FACT_WRITE_PATHS),
    lastText,
  };
}
