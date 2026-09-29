import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveJevDecisionService, MockJevDecisionService, validateJevDecision } from './jev-decision.js';
import { makeCandidates } from './jev-tool-provider.js';

const observation = {
  snapshot_id: 'snapshot-001',
  elements: [
    { element_index: 3, role: 'button', label: 'Submit' },
    { element_index: 4, role: 'text field', label: 'Verification code', value: 'secret existing value' },
  ],
};

describe('Jev candidate boundary', () => {
  it('constructs complete semantic actions from a fresh snapshot', () => {
    const candidates = makeCandidates(observation, 42, 123, 'user provided');
    expect(candidates.find(c => c.id === 'click_3')).toMatchObject({ tool: 'click', args: { pid: 42, window_id: 123, snapshot_id: 'snapshot-001', element_index: 3, delivery_mode: 'foreground' } });
    expect(candidates.find(c => c.id === 'type_4')).toMatchObject({ tool: 'type_text', args: { text: 'user provided' } });
    expect(candidates.map(c => c.id)).toEqual(expect.arrayContaining(['abstain', 'reobserve']));
  });
  it('does not create executable actions without a snapshot binding', () => {
    expect(makeCandidates({ ...observation, snapshot_id: undefined }, 42, 123).every(c => !c.tool)).toBe(true);
  });
  it('validates a provider selection against the immutable candidate table', async () => {
    const candidates = makeCandidates(observation, 42, 123);
    const selection = await new MockJevDecisionService().choose({ goal: 'submit', observation: 'safe', candidates });
    expect(validateJevDecision(selection, candidates).selectedId).toBe('click_3');
    expect(() => validateJevDecision({ selectedId: 'click_999', confidence: 1 }, candidates)).toThrow(/unknown/);
    expect(() => validateJevDecision({ selectedId: 'click_3', confidence: NaN }, candidates)).toThrow(/confidence/);
    expect(() => validateJevDecision({ selectedId: 'click_3', confidence: 0.9, probabilities: { unknown: 0.9 } }, candidates)).toThrow(/probabilities/);
  });
});

describe('Jev decision transport', () => {
  afterEach(() => {
    vi.doUnmock('@typesafe-ai/sdk');
    vi.resetModules();
  });

  function mockSdk() {
    const clientOptions: Record<string, unknown>[] = [];
    const requests: Record<string, unknown>[] = [];
    vi.doMock('@typesafe-ai/sdk', () => ({
      TypeSafeClient: class {
        constructor(options: Record<string, unknown>) {
          clientOptions.push(options);
        }
        systemOne(request: Record<string, unknown>) {
          requests.push(request);
          return Promise.resolve({
            answers: { candidate: { type: 'choice', choice: 'click_3', confidence: 0.9 } },
          });
        }
      },
      choice: (instructions: string, criteria: Record<string, string | null>) => ({ type: 'choice', instructions, criteria }),
    }));
    return { clientOptions, requests };
  }

  it('passes a provider connection endpoint, key, and model to the SDK', async () => {
    const { clientOptions, requests } = mockSdk();
    const candidates = makeCandidates(observation, 42, 123);
    const decision = await new LiveJevDecisionService({
      apiKey: 'sk-or-secret',
      baseURL: 'https://openrouter.ai/api',
      model: 'jev-1.13',
    }).choose({ goal: 'submit', observation: 'safe', candidates });

    expect(clientOptions).toEqual([
      { apiKey: 'sk-or-secret', baseURL: 'https://openrouter.ai/api', defaultModel: 'jev-1.13' },
    ]);
    expect(requests[0]).toMatchObject({ model: 'jev-1.13' });
    expect(decision).toEqual({ selectedId: 'click_3', confidence: 0.9 });
  });

  it('keeps the SDK defaults when no provider is configured', async () => {
    const { clientOptions, requests } = mockSdk();
    const candidates = makeCandidates(observation, 42, 123);
    await new LiveJevDecisionService({ apiKey: 'ts-key' }).choose({ goal: 'submit', observation: 'safe', candidates });

    expect(clientOptions).toEqual([{ apiKey: 'ts-key' }]);
    expect(requests[0]).not.toHaveProperty('model');
  });
});
