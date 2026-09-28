import { describe, expect, it } from 'vitest';
import { MockJevDecisionService, validateJevDecision } from './jev-decision.js';
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
    expect(candidates.find(c => c.id === 'click_3')).toMatchObject({ tool: 'click', args: { pid: 42, window_id: 123, snapshot_id: 'snapshot-001', element_index: 3, delivery_mode: 'background' } });
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
