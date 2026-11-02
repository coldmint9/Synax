import { PLACEHOLDER_BADGE_SOURCE, type ToolbarBadgeSource } from "./toolbarBadges";

/**
 * Placeholder identity for the account mark. Returning the frozen object keeps
 * identity stable, so nothing re-renders while no profile source is connected.
 */
export function useToolbarBadges(): ToolbarBadgeSource {
  return PLACEHOLDER_BADGE_SOURCE;
}
