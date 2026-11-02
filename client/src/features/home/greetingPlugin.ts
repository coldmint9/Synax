import type { ReactNode } from "react";
import type { Locale } from "../../shared/lib/i18n";
import type { GreetingPhase } from "./greetingPhase";

/**
 * Read-only facts a greeting plugin may key off. Plugins add their own surface
 * next to the greeting; they never rewrite its sentence or the quick actions.
 */
export interface GreetingPluginContext {
  locale: Locale;
  /** Signed-in display name, or null while nobody is signed in. */
  name: string | null;
  phase: GreetingPhase;
  /** The moment the greeting was rendered for. */
  now: Date;
}

/**
 * Extension point between the greeting and the quick actions: the slot a later
 * capability (smart reminders, standup digest, sessions blocked on an answer)
 * fills without touching the home layout. A plugin that returns nothing keeps
 * the page exactly as it is today.
 */
export interface GreetingPlugin {
  id: string;
  /** Lower renders first; defaults to 0. */
  order?: number;
  /** Return false to skip rendering without unregistering the capability. */
  available?: (context: GreetingPluginContext) => boolean;
  render: (context: GreetingPluginContext) => ReactNode;
}

/** This version ships no plugin, so the slot renders nothing at all. */
export const GREETING_PLUGINS: readonly GreetingPlugin[] = [];

export function activeGreetingPlugins(
  plugins: readonly GreetingPlugin[],
  context: GreetingPluginContext,
): GreetingPlugin[] {
  return plugins
    .filter((plugin) => (plugin.available ? plugin.available(context) : true))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}
