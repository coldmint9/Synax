/**
 * Contract for the top-right identity mark. No profile source is connected yet;
 * the placeholder below keeps the design renderable and removable.
 */
export interface ToolbarBadgeSource {
  readonly account: {
    readonly initial: string;
  };
}

/** Placeholder only: swap this object when the real profile store lands. */
export const PLACEHOLDER_BADGE_SOURCE: ToolbarBadgeSource = Object.freeze({
  account: Object.freeze({ initial: "Y" }),
});
