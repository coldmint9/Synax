import { beforeEach, describe, expect, it, vi } from 'vitest'

const createGatewayStream = vi.fn()
const validateGatewayModel = vi.fn()

vi.mock('../../services/llm-runtime/stream.js', () => ({
  createGatewayStream,
  validateGatewayModel,
}))

vi.mock('../../services/llm-runtime/provider-check.js', () => ({
  assertLlmProviderConfigured: vi.fn(),
}))

describe('llm routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('validates provider/model through the runtime service', async () => {
    validateGatewayModel.mockResolvedValueOnce({ ok: true, message: 'validated' })
    const { llmRoutes } = await import('../llm.js')

    const ok = await llmRoutes.request('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'openai', model: 'gpt-4o-mini' }),
    })

    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, message: 'validated' })

    validateGatewayModel.mockResolvedValueOnce({ ok: false, error: 'bad key' })
    const bad = await llmRoutes.request('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'openai', model: 'gpt-4o-mini' }),
    })

    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ ok: false, error: 'bad key' })
  })

  it('streams deltas and terminates with done sentinel', async () => {
    createGatewayStream.mockResolvedValueOnce({
      textStream: (async function* () {
        yield 'hello'
        yield ' world'
      })(),
    })

    const { llmRoutes } = await import('../llm.js')
    const res = await llmRoutes.request('http://localhost/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        purpose: 'wiki',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })

    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toContain('data: {"delta":"hello"}')
    expect(text).toContain('data: {"delta":" world"}')
    expect(text).toContain('data: [DONE]')
  })

  it('surfaces stream errors inside SSE output', async () => {
    createGatewayStream.mockRejectedValueOnce(new Error('gateway down'))
    const { llmRoutes } = await import('../llm.js')

    const res = await llmRoutes.request('http://localhost/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        purpose: 'wiki',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })

    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toContain('gateway down')
    expect(text).toContain('data: [DONE]')
  })
})
