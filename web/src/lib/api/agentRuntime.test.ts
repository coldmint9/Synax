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
    mockJson({ session: { id: 'ars_1' }, profile: { id: 'planner' }, context: null, candidateSkills: [] })

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
})
