import { describe, expect, it } from 'vitest';
import { BACKENDS } from '../backends/backend-contracts.js';
import { RUNTIME_PROTOCOL_VERSION } from '../runtime-protocol.js';

describe('runtime protocol v1', () => {
  it('publishes a capability-complete descriptor for every registered backend', () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe('synax.runtime.v1');
    expect(BACKENDS.length).toBeGreaterThan(0);
    for (const backend of BACKENDS) {
      expect(backend.capabilities).toEqual(expect.objectContaining({
        chat: expect.any(String),
        plan: expect.any(String),
        goal: expect.any(String),
        pause: expect.any(String),
        cancel: expect.any(String),
        interactions: expect.any(String),
        nativeSessionResume: expect.any(String),
        jsonlEvents: expect.any(String),
      }));
    }
  });

  it('keeps Native mode controls separate from external CLI backends', () => {
    expect(BACKENDS.find(backend => backend.id === 'native')?.capabilities).toMatchObject({
      plan: 'supported', goal: 'supported', nativeControls: 'supported',
    });
    expect(BACKENDS.find(backend => backend.id === 'codex')?.capabilities).toMatchObject({
      plan: 'unsupported', goal: 'unsupported', nativeControls: 'unsupported',
    });
    expect(BACKENDS.find(backend => backend.id === 'claude-code')?.capabilities).toMatchObject({
      plan: 'unsupported', goal: 'unsupported', nativeControls: 'unsupported',
    });
  });
});
