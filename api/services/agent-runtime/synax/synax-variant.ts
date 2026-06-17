import type { AgentProfile } from '../contracts.js';
import { profileService } from '../profile-service.js';

export const SYNAX_VARIANT_IDS = ['planner', 'explorer', 'reviewer'] as const;
export type SynaxVariantId = (typeof SYNAX_VARIANT_IDS)[number];

export interface SynaxVariant {
  id: SynaxVariantId;
  label: string;
  description: string;
  loopHints: string[];
  defaultSkills: string[];
  delegateProfileId?: string;
}

function variantFromProfile(
  id: SynaxVariantId,
  profile: AgentProfile,
  extras: { loopHints?: string[]; delegateProfileId?: string } = {},
): SynaxVariant {
  return {
    id,
    label: profile.label,
    description: profile.description,
    loopHints: extras.loopHints ?? profile.loopHints ?? [],
    defaultSkills: [...profile.defaultSkills],
    delegateProfileId: extras.delegateProfileId ?? id,
  };
}

export class SynaxVariantRegistry {
  private readonly variants = new Map<SynaxVariantId, SynaxVariant>();

  constructor() {
    this.registerBuiltins();
  }

  private registerBuiltins(): void {
    const planner = profileService.maybeGet('planner');
    const explorer = profileService.maybeGet('explorer');
    const reviewer = profileService.maybeGet('reviewer');

    if (planner) {
      this.variants.set('planner', variantFromProfile('planner', planner, {
        loopHints: [
          ...(planner.loopHints ?? []),
          'Break the request into bounded goals and next actions before editing code.',
          'Use task tools when decomposition needs to persist across steps.',
        ],
      }));
    }

    if (explorer) {
      this.variants.set('explorer', variantFromProfile('explorer', explorer, {
        loopHints: [
          ...(explorer.loopHints ?? []),
          'Prefer read-only investigation. Delegate wide searches via subagent.delegate(profileId: "explorer").',
        ],
        delegateProfileId: 'explorer',
      }));
    }

    if (reviewer) {
      this.variants.set('reviewer', variantFromProfile('reviewer', reviewer, {
        loopHints: [
          ...(reviewer.loopHints ?? []),
          'Focus on regressions, missing evidence, and acceptance criteria.',
          'Delegate deep diff review via subagent.delegate(profileId: "reviewer") when needed.',
        ],
        delegateProfileId: 'reviewer',
      }));
    }
  }

  get(variantId: string): SynaxVariant | undefined {
    return this.variants.get(variantId as SynaxVariantId);
  }

  getOrThrow(variantId: string): SynaxVariant {
    const variant = this.get(variantId);
    if (!variant) {
      throw new Error(`Unknown Synax variant "${variantId}". Available: ${SYNAX_VARIANT_IDS.join(', ')}`);
    }
    return variant;
  }

  list(): SynaxVariant[] {
    return [...this.variants.values()];
  }

  isAdaptable(variantId: string): variantId is SynaxVariantId {
    return this.variants.has(variantId as SynaxVariantId);
  }
}

export const synaxVariantRegistry = new SynaxVariantRegistry();
