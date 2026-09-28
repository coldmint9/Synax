export type ComputerUseStrategy = 'auto' | 'direct' | 'jev';
export interface ComputerUseSettings {
  enabled: boolean;
  strategy: ComputerUseStrategy;
  jev?: { enabled: boolean; fallback: 'direct' | 'fail_closed'; providerId?: string; model?: string };
  perception: 'disabled' | 'auto' | 'required';
}
export const DEFAULT_COMPUTER_USE_SETTINGS: ComputerUseSettings = {
  enabled: true,
  strategy: 'auto',
  perception: 'disabled',
};
/** Pure strategy decision: no API call, SDK import, or secret lookup. */
export function resolveComputerUseStrategy(settings: ComputerUseSettings = DEFAULT_COMPUTER_USE_SETTINGS): 'direct' | 'jev' | 'disabled' {
  if (!settings.enabled) return 'disabled';
  if (settings.strategy === 'direct') return 'direct';
  if (settings.strategy === 'jev' && !settings.jev?.enabled) throw new Error('Jev strategy requires an enabled Jev connection.');
  return settings.jev?.enabled ? 'jev' : 'direct';
}

/**
 * A project inherits global Computer Use defaults for every field it never changed.
 * Fields equal to the project default are treated as "not explicitly set".
 */
export function mergeComputerUseSettings(
  globalSettings: ComputerUseSettings | undefined,
  projectSettings: ComputerUseSettings | undefined,
): ComputerUseSettings {
  const defaults = DEFAULT_COMPUTER_USE_SETTINGS;
  const global: ComputerUseSettings = { ...defaults, ...globalSettings };
  if (!projectSettings) return global;
  const jev = projectSettings.jev ?? global.jev;
  return {
    enabled:
      projectSettings.enabled === defaults.enabled
        ? global.enabled
        : projectSettings.enabled,
    strategy:
      projectSettings.strategy === defaults.strategy
        ? global.strategy
        : projectSettings.strategy,
    perception:
      projectSettings.perception === defaults.perception
        ? global.perception
        : projectSettings.perception,
    ...(jev ? { jev } : {}),
  };
}
