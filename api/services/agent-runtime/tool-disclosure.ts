import * as z from 'zod/v4';
import type { CapabilityCategory, FallbackDisclosureConfig, RegisteredTool, ToolCallRecord, ToolMutability } from './contracts.js';

type LoopToolDef = { id: string; mutability: ToolMutability; category: CapabilityCategory };

export interface DisclosureTier {
  id: string;
  filter: (tool: LoopToolDef) => boolean;
}

export interface DisclosureStrategy {
  tiers: DisclosureTier[];
  escalationToolId: string;
}

export interface DisclosureState {
  tierIndex: number;
  stepsInTier: number;
}

export const ESCALATION_TOOL_ID = 'tools.escalate';

export const EXECUTOR_STRATEGY: DisclosureStrategy = {
  tiers: [
    { id: 'explore', filter: (t) => t.mutability === 'read' || t.category === 'skill' },
    { id: 'act', filter: () => true },
  ],
  escalationToolId: ESCALATION_TOOL_ID,
};

export const ESCALATION_TOOL: RegisteredTool = {
  id: ESCALATION_TOOL_ID,
  label: 'Unlock Write Tools',
  description:
    'Call this when you have gathered enough context and are ready to make file changes.',
  category: 'context',
  mutability: 'read',
  resumeBehavior: 'auto',
  progressiveDetails:
    'Accepts { reason: string }. Use it once exploration is complete and write-capable tools are needed.',
  inputSchema: z.object({
    reason: z.string().describe('Why write tools are needed now.'),
  }),
  execute: () => ({
    result: { promoted: true },
    displaySummary: 'Write tools unlocked for subsequent steps.',
    artifacts: [],
  }),
};

export function createState(): DisclosureState {
  return { tierIndex: 0, stepsInTier: 0 };
}

export function filterByDisclosure<T extends LoopToolDef>(
  tools: T[],
  state: DisclosureState,
  strategy: DisclosureStrategy,
): T[] {
  const tier = strategy.tiers[state.tierIndex];
  if (!tier) return tools;
  return tools.filter(tier.filter);
}

export function promote(state: DisclosureState): DisclosureState {
  return { tierIndex: state.tierIndex + 1, stepsInTier: 0 };
}

export function advance(state: DisclosureState): DisclosureState {
  return { ...state, stepsInTier: state.stepsInTier + 1 };
}

export function isTerminalTier(state: DisclosureState, strategy: DisclosureStrategy): boolean {
  return state.tierIndex >= strategy.tiers.length - 1;
}

export function rebuildState(
  toolCalls: Array<{ toolId: string }>,
  escalationToolId: string,
): DisclosureState {
  let state = createState();
  for (const call of toolCalls) {
    if (call.toolId === escalationToolId) state = promote(state);
    else state = advance(state);
  }
  return state;
}

export function getStrategyForProfile(profileKind: string): DisclosureStrategy | null {
  if (profileKind === 'executor') return EXECUTOR_STRATEGY;
  return null;
}

// ---------------------------------------------------------------------------
// Fallback disclosure — progressive tool reveal on repeated bash failures
// ---------------------------------------------------------------------------

export interface FallbackDisclosureState {
  consecutiveErrors: number;
  disclosed: boolean;
}

export function createFallbackState(): FallbackDisclosureState {
  return { consecutiveErrors: 0, disclosed: false };
}

/**
 * Determine if a bash tool call was an error based on its record.
 * Bash never throws — it always returns a completed result. We check:
 *   1. exitCode !== 0 (command ran but failed)
 *   2. exitCode === null (validation blocked execution — whitelist, redirect, etc.)
 */
export function isBashError(call: ToolCallRecord): boolean {
  const ref = call.outputRef as { exitCode?: number | null } | null;
  if (ref == null) return call.error != null;
  return ref.exitCode !== 0;
}

/**
 * Rebuild fallback state from historical tool calls (for resume).
 */
export function rebuildFallbackState(
  toolCalls: ToolCallRecord[],
  config: FallbackDisclosureConfig,
): FallbackDisclosureState {
  let consecutiveErrors = 0;
  let disclosed = false;
  for (const call of toolCalls) {
    if (call.toolId !== config.trackedToolId) continue;
    if (isBashError(call)) {
      consecutiveErrors++;
      if (consecutiveErrors >= config.consecutiveErrorThreshold) {
        disclosed = true;
      }
    } else {
      consecutiveErrors = 0;
    }
  }
  return { consecutiveErrors, disclosed };
}

/**
 * Update fallback state after a single tool call completes.
 * Returns { state, justDisclosed } — justDisclosed is true on the transition edge.
 */
export function advanceFallbackState(
  state: FallbackDisclosureState,
  call: ToolCallRecord,
  config: FallbackDisclosureConfig,
): { state: FallbackDisclosureState; justDisclosed: boolean } {
  if (state.disclosed) return { state, justDisclosed: false };
  if (call.toolId !== config.trackedToolId) return { state, justDisclosed: false };

  if (isBashError(call)) {
    const next = state.consecutiveErrors + 1;
    const nowDisclosed = next >= config.consecutiveErrorThreshold;
    return {
      state: { consecutiveErrors: next, disclosed: nowDisclosed },
      justDisclosed: nowDisclosed,
    };
  }

  // Success resets the counter.
  return { state: { consecutiveErrors: 0, disclosed: false }, justDisclosed: false };
}

/**
 * Filter out fallback tools that haven't been disclosed yet.
 */
export function filterFallbackTools<T extends { id: string }>(
  tools: T[],
  state: FallbackDisclosureState,
  config: FallbackDisclosureConfig,
): T[] {
  if (state.disclosed) return tools;
  const hidden = new Set(config.fallbackToolIds);
  return tools.filter(t => !hidden.has(t.id));
}
