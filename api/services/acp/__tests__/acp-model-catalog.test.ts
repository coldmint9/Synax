import { describe, expect, it } from 'vitest';
import { mapSessionModels } from '../acp-model-catalog.js';

describe('mapSessionModels', () => {
  it('maps available ACP models to catalog entries', () => {
    expect(mapSessionModels({
      currentModelId: 'auto',
      availableModels: [
        { modelId: 'auto', name: 'Auto' },
        { modelId: 'claude-4-sonnet', name: 'Claude 4 Sonnet', description: 'Fast' },
      ],
    })).toEqual([
      { id: 'auto', label: 'Auto', description: null },
      { id: 'claude-4-sonnet', label: 'Claude 4 Sonnet', description: 'Fast' },
    ]);
  });

  it('returns empty list when agent exposes no models', () => {
    expect(mapSessionModels(null)).toEqual([]);
    expect(mapSessionModels({ currentModelId: 'auto', availableModels: [] })).toEqual([]);
  });
});
