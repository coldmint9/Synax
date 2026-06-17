import { describe, expect, it } from 'vitest';
import { synaxIntentRouter } from '../synax-intent-router.js';
import { synaxVariantRegistry } from '../synax-variant.js';

describe('SynaxIntentRouter', () => {
  it('routes review intent to reviewer variant', () => {
    const decision = synaxIntentRouter.route({
      message: 'Please review this PR for regressions',
      mode: 'chat',
      metadata: {},
    });
    expect(decision?.variantId).toBe('reviewer');
  });

  it('routes planning intent to planner variant', () => {
    const decision = synaxIntentRouter.route({
      message: 'Help me plan and break down this feature',
      mode: 'chat',
      metadata: {},
    });
    expect(decision?.variantId).toBe('planner');
  });

  it('routes exploration intent to explorer variant', () => {
    const decision = synaxIntentRouter.route({
      message: 'Explore the codebase and find where auth is handled',
      mode: 'chat',
      metadata: {},
    });
    expect(decision?.variantId).toBe('explorer');
  });

  it('skips routing for goal mode sessions', () => {
    expect(synaxIntentRouter.route({
      message: 'review the login flow',
      mode: 'goal',
      metadata: {},
    })).toBeNull();
  });

  it('skips routing when a variant is already active', () => {
    expect(synaxIntentRouter.route({
      message: 'review the login flow',
      mode: 'chat',
      metadata: { activeVariant: 'planner' },
    })).toBeNull();
  });
});

describe('SynaxVariantRegistry', () => {
  it('exposes builtin variants', () => {
    const ids = synaxVariantRegistry.list().map((variant) => variant.id);
    expect(ids).toEqual(expect.arrayContaining(['planner', 'explorer', 'reviewer']));
  });
});
