// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimeApi } from './agentRuntime'

const originalFetch = globalThis.fetch

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

function mockJson(body: unknown, ok = true, status = 200) {
  globalThis.fetch = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch
}

describe('agentRuntimeApi', () => {
  it('creates sessions through the agent runtime base path', async () => {
    mockJson({ session: { id: 'ars_1' }, profile: { id: 'planner' }, context: null })

    const result = await agentRuntimeApi.createSession({
      projectId: 'p1',
      profileId: 'planner',
      prompt: 'Plan the work',
    })

    expect(result.session.id).toBe('ars_1')
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/agent-runtime/sessions', expect.objectContaining({ method: 'POST' }))
  })

  it('reads sessions and permission decisions', async () => {
    mockJson({ items: [] })

    await agentRuntimeApi.listSessions({ projectId: 'p1', status: 'running' })
    await agentRuntimeApi.listPermissions('ars_1')

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      '/api/agent-runtime/sessions?projectId=p1&status=running',
      expect.any(Object),
    )
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      '/api/agent-runtime/sessions/ars_1/permissions',
      expect.any(Object),
    )
  })

  it('deletes sessions through the agent runtime base path', async () => {
    mockJson({ ok: true, deletedSessionIds: ['ars_1'] })

    const result = await agentRuntimeApi.deleteSession('ars_1')

    expect(result.deletedSessionIds).toEqual(['ars_1'])
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/agent-runtime/sessions/ars_1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('uses the durable interaction and mode wire contracts, encoding both IDs', async () => {
    mockJson({ interactions: [{ id: 'i/1', revision: 2 }] })
    expect((await agentRuntimeApi.listInteractions('s/1')).interactions[0].revision).toBe(2)
    mockJson({ interaction: { id: 'i/1', status: 'answered' } })
    const reply = { revision: 2, action: 'submit' as const, answers: { count: 0, yes: false, scope: ['web'] } }
    expect((await agentRuntimeApi.replyInteraction('s/1', 'i/1', reply)).interaction.status).toBe('answered')
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/agent-runtime/sessions/s%2F1/interactions/i%2F1/reply', expect.objectContaining({
      method: 'POST', body: JSON.stringify(reply),
    }))
    mockJson({ session: { id: 's/1', sessionMetadata: { mode: 'plan' } } })
    expect((await agentRuntimeApi.updateSessionMode('s/1', 'plan')).session.sessionMetadata?.mode).toBe('plan')
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/agent-runtime/sessions/s%2F1/mode', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ mode: 'plan' }),
    }))
  })

  it('propagates a stale interaction server error instead of reporting success', async () => {
    mockJson({ error: 'The form is stale. Reload it before submitting.', code: 'CONFLICT' }, false, 409)
    await expect(agentRuntimeApi.replyInteraction('s1', 'i1', { revision: 1, action: 'execute' }))
      .rejects.toThrow('The form is stale')
  })
})
