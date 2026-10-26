import { describe, expect, it } from 'vitest'

describe('config routes', () => {
  it('saves and clears the optional supplier output limit', async () => {
    const { configRoutes } = await import('../config.js');
    for (const maxOutputTokens of [65_536, undefined]) {
      const response = await configRoutes.request('http://localhost/global', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerConnections: { openai: { providerId: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'fixture-key', extra: { kind: 'api', model: 'gpt-4o-mini', maxOutputTokens } } } }),
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.config.providerConnections.openai.extra.maxOutputTokens).toBe(maxOutputTokens);
    }
  });

  it.each([0, -1, 1.5, 10_000_001, '8192'])('rejects invalid supplier output limit %j', async maxOutputTokens => {
    const { configRoutes } = await import('../config.js');
    const response = await configRoutes.request('http://localhost/global', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerConnections: { openai: { providerId: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'fixture-key', extra: { model: 'gpt-4o-mini', maxOutputTokens } } } }),
    });
    expect(response.status).toBe(400);
  });

  it('returns global provider list from config-store view', async () => {
    const { configRoutes } = await import('../config.js')
    const res = await configRoutes.request('http://localhost/global/providers')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Array.isArray(body.providers)).toBe(true)
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openai',
          kind: 'api',
          models: expect.arrayContaining([
            expect.objectContaining({ id: 'gpt-4o-mini' }),
          ]),
        }),
      ]),
    )
  })

  it('returns 404 for removed provider-models legacy endpoint', async () => {
    const { configRoutes } = await import('../config.js')
    const missing = await configRoutes.request('http://localhost/global/providers/unknown/models')

    expect(missing.status).toBe(404)
  })

  it('accepts and persists macOS window material settings', async () => {
    const { configRoutes } = await import('../config.js')
    const appearance = {
      enabled: true,
      vibrancy: 'hud-window',
      opacity: 0.35,
      bottomSeparator: false,
      scanlines: true,
      scanlineOpacity: 0.08,
    }
    const res = await configRoutes.request('http://localhost/global', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ macWindowAppearance: appearance }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.config.macWindowAppearance).toEqual(appearance)
  })
})

it.each([
  { enabledAcpProviderIds: ['codex-acp'] },
  { defaultProviderId: 'cursor-acp' },
  { providers: [{ id: 'retired', label: 'Retired ACP', status: 'live', kind: 'acp', caps: { canFollowUp: true, canCancel: true }, models: [] }] },
])('rejects retired ACP configuration %j', async patch => {
  const { configRoutes } = await import('../config.js');
  const response = await configRoutes.request('http://localhost/global', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  expect(response.status).toBe(400);
});

it('excludes retired providers and connections when normalizing persisted settings', async () => {
  const { updateGlobalConfig, getGlobalConfigForRuntime } = await import('../../../infrastructure/runtime/config/config-store.js');
  updateGlobalConfig({ providers: [{ id: 'codex-acp', label: 'Old', kind: 'acp', status: 'live', caps: { canFollowUp: true, canCancel: true }, models: [] }],
    defaultProviderId: 'codex-acp', enabledAcpProviderIds: ['codex-acp'],
    providerConnections: { 'codex-acp': { providerId: 'codex-acp', extra: { kind: 'acp' } } } }, 'migration-test');
  const current = getGlobalConfigForRuntime();
  expect(current.providers.every(provider => provider.kind === 'api')).toBe(true);
  expect(current.providerConnections).not.toHaveProperty('codex-acp');
  expect(current.defaultProviderId).toBe('openai');
  expect(current.enabledAcpProviderIds).toEqual([]);
});
