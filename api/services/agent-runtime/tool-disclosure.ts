import * as z from 'zod/v4';
import type { CapabilityCategory, RegisteredTool, ToolMutability } from './contracts.js';

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
