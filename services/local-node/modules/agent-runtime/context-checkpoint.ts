import * as z from "zod/v4";

// Keep these limits in sync with runtime-sidecar/src/agent/checkpoint.rs.
// A checkpoint is bounded state plus a log boundary, never a transcript/index.
export const CHECKPOINT_MAX_BYTES = 128 * 1024;
export const CHECKPOINT_MAX_SUMMARY_TOKENS = 12_000;
export const CHECKPOINT_MAX_REFS = 64;
export const CHECKPOINT_MAX_ID_BYTES = 256;

const encoder = new TextEncoder();
const id = z.string().min(1).max(CHECKPOINT_MAX_ID_BYTES).refine(
  value => encoder.encode(value).length <= CHECKPOINT_MAX_ID_BYTES,
  "Checkpoint reference exceeds the UTF-8 byte limit",
);
const entries = z.array(z.string().min(1).max(16_384)).max(128);

export const structuredSummarySchema = z.object({
  goal: entries,
  constraints: entries,
  decisions: entries,
  completedWork: entries,
  evidence: entries,
  failures: entries,
  openQuestions: entries,
  nextActions: entries,
}).strict();

export const contextCheckpointSchema = z.object({
  version: z.literal(1),
  id,
  sessionId: id,
  compactionRunId: id,
  throughRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  throughStepId: id,
  summary: structuredSummarySchema,
  sourceRefs: z.array(id).max(CHECKPOINT_MAX_REFS).refine(
    refs => new Set(refs).size === refs.length,
    "Checkpoint references must be unique",
  ),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

export type StructuredSummary = z.infer<typeof structuredSummarySchema>;
export type ContextCheckpoint = z.infer<typeof contextCheckpointSchema>;

/** Bound the encoded input before JSON parsing, then validate bounded state.
 * Reference resolution is deliberately outside this parser: callers use the
 * existing history index, never load the whole session to validate 64 ids. */
export function parseContextCheckpoint(
  encoded: string,
  countTokens: (text: string) => number,
  summaryBudget = CHECKPOINT_MAX_SUMMARY_TOKENS,
): ContextCheckpoint {
  if (encoded.length > CHECKPOINT_MAX_BYTES || encoder.encode(encoded).length > CHECKPOINT_MAX_BYTES)
    throw new Error("checkpoint_too_large: encoded checkpoint exceeds 128 KiB");
  if (!Number.isSafeInteger(summaryBudget) || summaryBudget <= 0 || summaryBudget > CHECKPOINT_MAX_SUMMARY_TOKENS)
    throw new Error("invalid_checkpoint_budget");
  const checkpoint = contextCheckpointSchema.parse(JSON.parse(encoded));
  const tokens = countTokens(JSON.stringify(checkpoint.summary));
  if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > summaryBudget)
    throw new Error("checkpoint_summary_exceeds_budget");
  return checkpoint;
}

export interface ContextBudget {
  contextLimit: number;
  inputLimit?: number;
  outputReserve: number;
}

/** inputLimit already excludes output; never subtract outputReserve from it. */
export function contextInputBudget(budget: ContextBudget): number {
  for (const [name, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 10_000_000))
      throw new RangeError(`Invalid context budget ${name}`);
  }
  if (budget.outputReserve >= budget.contextLimit)
    throw new RangeError("Output reservation must be smaller than the context window");
  return Math.min(budget.contextLimit - budget.outputReserve, budget.inputLimit ?? budget.contextLimit);
}
