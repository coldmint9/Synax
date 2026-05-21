import { describe, expect, it } from 'vitest'

describe('config routes', () => {
  it('returns global provider list from config-store view', async () => {
    const { configRoutes } = await import('../config.js')
    const res = await configRoutes.request('http://localhost/global/providers')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Array.isArray(body.providers)).toBe(true)
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'opencode-acp',
          kind: 'acp',
        }),
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
})
