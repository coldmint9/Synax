import type { AgentProfile } from '../contracts.js';
import { profileService } from '../profile-service.js';

export const SYNAX_VARIANT_IDS = ['planner', 'explorer', 'reviewer'] as const;
export type SynaxVariantId = (typeof SYNAX_VARIANT_IDS)[number];

export interface SynaxVariant {
  id: SynaxVariantId;
  label: string;
  description: string;
  loopHints: string[];
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
          'Focus on decisions, constraints and acceptance criteria. Keep the proposal proportional to the task.',
        ],
      }));
    }

    if (explorer) {
      this.variants.set('explorer', variantFromProfile('explorer', explorer, {
        loopHints: [
          'Find the smallest evidence set that answers the question; distinguish observed facts from inference.',
        ],
        delegateProfileId: 'explorer',
      }));
    }

    if (reviewer) {
      this.variants.set('reviewer', variantFromProfile('reviewer', reviewer, {
        loopHints: [
          'Prioritize concrete regressions, missing evidence and acceptance risks; cite the affected code.',
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
