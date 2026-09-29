import { describe, expect, it } from 'vitest';
import { configRoutes } from '../config.js';

const provider = {
  id: 'custom-api:studio',
  label: 'Studio',
  status: 'live',
  kind: 'api',
  caps: { canFollowUp: true, canCancel: true },
  models: [{
    id: 'render-image',
    label: 'Render Image',
    capabilities: ['image_generation'],
    media: { operations: ['text-to-video'] },
  }],
};

describe('media provider configuration', () => {
  it('rejects a generation capability without a compatible operation', async () => {
    const response = await configRoutes.request('http://localhost/global', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: [provider] }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain('image_generation');
  });

  it('rejects an explicitly empty model capability list', async () => {
    const response = await configRoutes.request('http://localhost/global', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: [{
        ...provider, models: [{ ...provider.models[0], capabilities: [] }],
      }] }),
    });
    expect(response.status).toBe(400);
  });
});
