import { expect, it } from 'vitest';
import { enableDirectFallback, canUseDirectFallback, clearDirectFallback } from './fallback.js';
it('does not expose raw Cua tools before an explicit Jev fallback and clears on demand', () => {
  expect(canUseDirectFallback('session')).toBe(false);
  enableDirectFallback('session');
  expect(canUseDirectFallback('session')).toBe(true);
  clearDirectFallback('session');
  expect(canUseDirectFallback('session')).toBe(false);
});
