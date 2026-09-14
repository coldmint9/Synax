import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentSessionStore as store } from '../agentSessionStore'
import { agentRuntimeApi as api, type AgentSession, type SessionStats } from '../../../../lib/api/agentRuntime'
const session = { id: 'refresh-session', projectId: 'p', status: 'running', childSessionIds: [] } as unknown as AgentSession
const stats = (status: 'running' | 'completed') => ({ status, runningDuration: 1000, tokenUsage: { input: 1, output: 1, total: 2 }, contextLimit: 1000, contextUsedPercent: 0, toolCallCount: 0, activeSubAgentCount: 0 }) as SessionStats
beforeEach(() => {
  store.setState({ ...store.getInitialState(), sessions: [session], selectedSessionId: session.id })
  vi.spyOn(api, 'getSessionStats').mockResolvedValue(stats('completed'))
  vi.spyOn(api, 'getSessionTodos').mockResolvedValue({ items: [] })
  vi.spyOn(api, 'getSessionCapabilities').mockResolvedValue({} as never)
  for (const key of ['listSessionSteps', 'listRuns', 'listEvents', 'listMessages', 'listToolCalls', 'listPermissions'] as const) vi.spyOn(api, key).mockResolvedValue({ items: [] })
})
afterEach(() => { vi.restoreAllMocks(); store.setState(store.getInitialState()) })
describe('detail refresh freshness', () => {
  it('performs a trailing refresh when completion arrives during a running stats request', async () => {
    let resolve!: (value: SessionStats) => void
    vi.mocked(api.getSessionStats).mockReturnValueOnce(new Promise(r => { resolve = r }))
    const first = store.getState().refreshDetail()
    store.getState().patchSession(session.id, { status: 'completed' })
    const trailing = store.getState().refreshDetail()
    resolve(stats('running'))
    await Promise.all([first, trailing])
    expect(api.getSessionStats).toHaveBeenCalledTimes(2)
    expect(store.getState().sessionStats?.status).toBe('completed')
  })
  it('does not let a detached old transcript response replace a newer one', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.listMessages>>) => void
    vi.mocked(api.listMessages).mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValueOnce({ items: [{ id: 'new', content: 'newest' } as never] })
    await store.getState().refreshDetail()
    await store.getState().refreshDetail()
    resolve({ items: [{ id: 'old', content: 'stale' } as never] })
    await Promise.resolve(); await Promise.resolve()
    expect(store.getState().messages.map(message => message.id)).toEqual(['new'])
  })
})
