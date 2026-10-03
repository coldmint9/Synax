import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPUTER_USE_SETTINGS, resolveComputerUseStrategy } from './strategy.js';

describe('computer use strategy', () => {
  it('uses Direct Cua without initializing or configuring Jev', () => {
    expect(resolveComputerUseStrategy()).toBe('direct');
    expect(resolveComputerUseStrategy({ ...DEFAULT_COMPUTER_USE_SETTINGS, jev: { enabled: false, fallback: 'fail_closed' } })).toBe('direct');
  });
  it('allows explicit Direct Cua even with Jev configured', () => {
    expect(resolveComputerUseStrategy({ ...DEFAULT_COMPUTER_USE_SETTINGS, strategy: 'direct', jev: { enabled: true, fallback: 'fail_closed' } })).toBe('direct');
  });
  it('does not silently bypass an explicitly requested Jev strategy', () => {
    expect(() => resolveComputerUseStrategy({ ...DEFAULT_COMPUTER_USE_SETTINGS, strategy: 'jev' })).toThrow(/requires/);
    expect(resolveComputerUseStrategy({ ...DEFAULT_COMPUTER_USE_SETTINGS, strategy: 'jev', jev: { enabled: true, fallback: 'fail_closed' } })).toBe('jev');
  });
  it('disables the capability when the user turns it off', () => {
    expect(resolveComputerUseStrategy({ ...DEFAULT_COMPUTER_USE_SETTINGS, enabled: false })).toBe('disabled');
  });
});
