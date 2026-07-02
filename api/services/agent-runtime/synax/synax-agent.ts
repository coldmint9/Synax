import type { AgentSession } from '../contracts.js';
import { profileService } from '../profile-service.js';
import { registerTitleGenerator } from '../session-title-service.js';
import { toolRegistry } from '../tool-registry.js';
import { agentRuntimeStore } from '../session-store.js';
import { agentEventService } from '../event-service.js';
import { nowIso } from '../runtime-ids.js';
import { goalTitleGenerator } from '../../wiki/wiki-goal-title.js';
import { synaxAgentProfile } from './synax-agent-profile.js';
import { createSynaxAdaptTool } from './synax-adapt-tool.js';
import { synaxIntentRouter, type SynaxRouteDecision } from './synax-intent-router.js';
import {
  inferSynaxSessionMode,
  isGoalLikeMode,
  isSynaxProfile,
  LEGACY_GOAL_PROFILE_ID,
  SYNAX_AGENT_PROFILE_ID,
  type SynaxSessionMetadata,
  type SynaxSessionMode,
} from './synax-session-mode.js';
import { buildSynaxIntentPromptSection } from './synax-intent-hints.js';
import { synaxModePromptRegistry } from './synax-mode-prompt.js';
import { synaxVariantRegistry, type SynaxVariantId } from './synax-variant.js';

export type SynaxRouteSource = 'auto' | 'adapt';

export interface SynaxVariantState {
  activeVariant: SynaxVariantId;
  routeReason: string;
  routedAt: string;
  routeSource: SynaxRouteSource;
}

export class SynaxAgent {
  private registered = false;
  private adaptToolRegistered = false;

  get profileId(): string {
    return SYNAX_AGENT_PROFILE_ID;
  }

  register(): void {
    if (this.registered) return;
    profileService.register(synaxAgentProfile);
    registerTitleGenerator(SYNAX_AGENT_PROFILE_ID, goalTitleGenerator);
    this.registerAdaptTool();
    this.registered = true;
  }

  private registerAdaptTool(): void {
    if (this.adaptToolRegistered) return;
    toolRegistry.register(createSynaxAdaptTool(this));
    this.adaptToolRegistered = true;
  }

  isSynaxSession(session: Pick<AgentSession, 'profileId'>): boolean {
    return isSynaxProfile(session.profileId);
  }

  resolveMode(session: Pick<AgentSession, 'profileId' | 'sessionMetadata'>): SynaxSessionMode {
    return inferSynaxSessionMode({
      profileId: session.profileId,
      sessionMetadata: session.sessionMetadata,
    });
  }

  asMetadata(metadata: Record<string, unknown> | null | undefined): SynaxSessionMetadata {
    return (metadata ?? {}) as SynaxSessionMetadata;
  }

  resolveVariantState(session: Pick<AgentSession, 'sessionMetadata'>): SynaxVariantState | null {
    const metadata = this.asMetadata(session.sessionMetadata);
    if (!metadata.activeVariant || !synaxVariantRegistry.isAdaptable(metadata.activeVariant)) {
      return null;
    }
    return {
      activeVariant: metadata.activeVariant,
      routeReason: metadata.routeReason ?? 'Specialized variant active.',
      routedAt: typeof metadata.routedAt === 'string' ? metadata.routedAt : '',
      routeSource: metadata.routeSource === 'adapt' ? 'adapt' : 'auto',
    };
  }

  buildModePromptSection(session: Pick<AgentSession, 'profileId' | 'sessionMetadata' | 'prompt'>): string | null {
    if (!this.isSynaxSession(session)) return null;
    const mode = this.resolveMode(session);
    return synaxModePromptRegistry.buildSection({
      mode,
      metadata: this.asMetadata(session.sessionMetadata),
      prompt: session.prompt,
    });
  }

  buildIntentPromptSection(
    session: Pick<AgentSession, 'profileId' | 'sessionMetadata'>,
    message: string,
    stepIndex = 1,
  ): string | null {
    if (!this.isSynaxSession(session)) return null;
    return buildSynaxIntentPromptSection({
      message,
      mode: this.resolveMode(session),
      stepIndex,
    });
  }

  buildVariantPromptSection(session: Pick<AgentSession, 'profileId' | 'sessionMetadata'>): string | null {
    if (!this.isSynaxSession(session)) return null;
    const state = this.resolveVariantState(session);
    if (!state) return null;

    const variant = synaxVariantRegistry.get(state.activeVariant);
    if (!variant) return null;

    const lines = [
      `Active variant: ${variant.label} (${variant.id}).`,
      `Route reason: ${state.routeReason}`,
      'Variant hints:',
      ...variant.loopHints.map((hint) => `- ${hint}`),
    ];
    if (variant.id === 'explorer') {
      lines.push('- Exploration variant: delegate discovery via subagent.delegate(profileId: "explorer"); children run wiki-first then code evidence.');
    } else if (variant.delegateProfileId) {
      lines.push(`- For isolated deep work, delegate via subagent.delegate(profileId: "${variant.delegateProfileId}").`);
    }
    return lines.join('\n');
  }

  buildEffectiveLoopHints(session: Pick<AgentSession, 'profileId' | 'sessionMetadata'>): string[] {
    if (!this.isSynaxSession(session)) return [];
    const baseHints = synaxAgentProfile.loopHints ?? [];
    const variant = this.resolveVariantState(session);
    if (!variant) return baseHints;
    const variantHints = synaxVariantRegistry.get(variant.activeVariant)?.loopHints ?? [];
    return dedupeLoopHints([...baseHints, ...variantHints]);
  }

  createSessionMetadata(
    mode: SynaxSessionMode,
    extras: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { mode, ...extras };
  }

  applyVariant(
    sessionId: string,
    variantId: SynaxVariantId,
    reason: string,
    source: SynaxRouteSource,
  ): SynaxVariantState {
    const variant = synaxVariantRegistry.getOrThrow(variantId);
    const routedAt = nowIso();
    const patch = {
      activeVariant: variant.id,
      routeReason: reason,
      routedAt,
      routeSource: source,
    };

    agentRuntimeStore.updateSessionMetadata(sessionId, patch);

    return {
      activeVariant: variant.id,
      routeReason: reason,
      routedAt,
      routeSource: source,
    };
  }

  maybeAutoRoute(sessionId: string, message: string): SynaxRouteDecision | null {
    const session = agentRuntimeStore.getSession(sessionId);
    if (!this.isSynaxSession(session)) return null;

    const mode = this.resolveMode(session);
    if (isGoalLikeMode(mode)) return null;

    const decision = synaxIntentRouter.route({
      message,
      mode,
      metadata: this.asMetadata(session.sessionMetadata),
    });
    if (!decision) return null;

    this.applyVariant(sessionId, decision.variantId, decision.reason, 'auto');
    agentEventService.append({
      sessionId,
      type: 'progress_updated',
      summary: `Routed to ${decision.variantId}`,
      payload: {
        activeVariant: decision.variantId,
        routeReason: decision.reason,
        routeSource: 'auto',
      },
    });
    return decision;
  }
}

function dedupeLoopHints(hints: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const hint of hints) {
    const key = hint.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(hint);
  }
  return result;
}

export const synaxAgent = new SynaxAgent();

let legacyGoalRegistered = false;

/** Register the universal Synax agent profile. */
export function ensureSynaxAgentRegistered(): void {
  synaxAgent.register();
}

/** Keep legacy goal profile available for sessions already stored with profileId "goal". */
export function ensureLegacyGoalProfileRegistered(): void {
  ensureSynaxAgentRegistered();
  if (legacyGoalRegistered) return;
  if (!profileService.maybeGet(LEGACY_GOAL_PROFILE_ID)) {
    profileService.register({
      ...synaxAgentProfile,
      id: LEGACY_GOAL_PROFILE_ID,
      label: 'Synax',
      description: 'Deprecated profileId alias for legacy sessions; use profileId "synax" with sessionMetadata.mode.',
      maxSteps: 48,
      loopHints: [
        'Work toward the user goal with bounded, verifiable steps.',
        'Read and search before editing. Prefer edit for surgical changes.',
        'When wiki context is attached, keep documentation in sync after code changes.',
      ],
    });
    registerTitleGenerator(LEGACY_GOAL_PROFILE_ID, goalTitleGenerator);
  }
  legacyGoalRegistered = true;
}
