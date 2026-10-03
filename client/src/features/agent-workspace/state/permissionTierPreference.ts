import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  DEFAULT_SYNAX_PERMISSION_TIER,
  isSynaxPermissionTier,
  type SynaxPermissionTier,
} from "../synaxSessionTypes";

/**
 * Remembers the approval tier the user picked last so a new session inherits it.
 * The scope is global (one value per browser profile), not per project.
 */
export const PERMISSION_TIER_PREFERENCE_KEY = "synax-permission-tier-v1";

interface PermissionTierPreferenceState {
  lastTier: SynaxPermissionTier;
  rememberTier: (tier: SynaxPermissionTier) => void;
  reset: () => void;
}

export const usePermissionTierPreference =
  create<PermissionTierPreferenceState>()(
    persist(
      (set) => ({
        lastTier: DEFAULT_SYNAX_PERMISSION_TIER,
        rememberTier: (tier) => set({ lastTier: tier }),
        reset: () => set({ lastTier: DEFAULT_SYNAX_PERMISSION_TIER }),
      }),
      {
        name: PERMISSION_TIER_PREFERENCE_KEY,
        storage: createJSONStorage(() => localStorage),
        partialize: (state) => ({ lastTier: state.lastTier }),
        merge: (persisted, current) => {
          const lastTier = (persisted as { lastTier?: unknown } | undefined)
            ?.lastTier;
          return {
            ...current,
            lastTier: isSynaxPermissionTier(lastTier)
              ? lastTier
              : DEFAULT_SYNAX_PERMISSION_TIER,
          };
        },
      },
    ),
  );

/** Tier a brand-new session starts from; boundary when nothing valid was stored. */
export function readLastPermissionTier(): SynaxPermissionTier {
  const tier = usePermissionTierPreference.getState().lastTier;
  return isSynaxPermissionTier(tier) ? tier : DEFAULT_SYNAX_PERMISSION_TIER;
}

export function rememberPermissionTier(tier: SynaxPermissionTier): void {
  usePermissionTierPreference.getState().rememberTier(tier);
}
