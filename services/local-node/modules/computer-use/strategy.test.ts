import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPUTER_USE_SETTINGS, mergeComputerUseSettings, resolveComputerUseStrategy } from './strategy.js';

const enabledSettings = { ...DEFAULT_COMPUTER_USE_SETTINGS, enabled: true };

describe('computer use strategy', () => {
  it('uses Direct Cua without initializing or configuring Jev', () => {
    expect(resolveComputerUseStrategy(enabledSettings)).toBe('direct');
    expect(resolveComputerUseStrategy({ ...enabledSettings, jev: { enabled: false, fallback: 'fail_closed' } })).toBe('direct');
  });
  it('allows explicit Direct Cua even with Jev configured', () => {
    expect(resolveComputerUseStrategy({ ...enabledSettings, strategy: 'direct', jev: { enabled: true, fallback: 'fail_closed' } })).toBe('direct');
  });
  it('does not silently bypass an explicitly requested Jev strategy', () => {
    expect(() => resolveComputerUseStrategy({ ...enabledSettings, strategy: 'jev' })).toThrow(/requires/);
    expect(resolveComputerUseStrategy({ ...enabledSettings, strategy: 'jev', jev: { enabled: true, fallback: 'fail_closed' } })).toBe('jev');
  });
  it('disables the capability when the user turns it off', () => {
    expect(resolveComputerUseStrategy()).toBe('disabled');
    expect(resolveComputerUseStrategy({ ...DEFAULT_COMPUTER_USE_SETTINGS, enabled: false })).toBe('disabled');
  });
  it('requires global opt-in and lets projects further disable access', () => {
    expect(mergeComputerUseSettings(undefined, enabledSettings).enabled).toBe(false);
    expect(mergeComputerUseSettings(DEFAULT_COMPUTER_USE_SETTINGS, enabledSettings).enabled).toBe(false);
    expect(mergeComputerUseSettings(enabledSettings, undefined).enabled).toBe(true);
    expect(mergeComputerUseSettings(enabledSettings, enabledSettings).enabled).toBe(true);
    expect(mergeComputerUseSettings(enabledSettings, DEFAULT_COMPUTER_USE_SETTINGS).enabled).toBe(false);
  });
});
