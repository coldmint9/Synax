import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startProjectRecovery, useShellStore } from './shellStore'
import { startApiConnectivityMonitor, useApiConnectivityStore } from '../../lib/apiConnectivity'

vi.mock('../../lib/api/runtimeEventBus', () => ({ resumeRuntimeEventBus: vi.fn() }))

const project = { id: 'proj-sleep', name: 'My project' }
const response = (items = [project]) => new Response(JSON.stringify({ items }))
let stopRecovery: () => void
let stopMonitor: (() => void) | undefined

beforeEach(() => {
  useApiConnectivityStore.setState({ browserOnline: true, apiReachable: 'unreachable', recoveryVersion: 0 })
  useApiConnectivityStore.setState({ apiReachable: 'unknown' })
  useShellStore.setState({ projects: [], projectsLoaded: false, currentProjectId: project.id })
  stopRecovery = startProjectRecovery()
})
afterEach(() => {
  stopRecovery()
  stopMonitor?.()
  stopMonitor = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('project list recovery', () => {
  it('backs off if projects keeps returning 500 while health remains reachable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(
      url.endsWith('/health') ? new Response(null, { status: 200 }) : new Response(null, { status: 500 }),
    )))
    stopMonitor = startApiConnectivityMonitor()
    await vi.advanceTimersByTimeAsync(0)
    await useShellStore.getState().fetchProjects()
    const projectCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/projects')).length
    expect(projectCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(projectCalls()).toBe(2)

    // A different API response can also mark the connection healthy; it must
    // not immediately retry /projects or create a cascade of stream restarts.
    useApiConnectivityStore.getState().markSuccess()
    await vi.advanceTimersByTimeAsync(9999)
    expect(projectCalls()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(projectCalls()).toBe(3)
  })

  it.each(['add', 'remove', 'update'] as const)('preserves a project %s completed during a recovery refresh', async (mutation) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response()))
    await useShellStore.getState().fetchProjects()
    let resolveStale!: (response: Response) => void
    let resolveFresh!: (response: Response) => void
    vi.mocked(fetch)
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveStale = resolve }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFresh = resolve }))
    useApiConnectivityStore.getState().markSuccess(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const store = useShellStore.getState()
    if (mutation === 'remove') store.removeProject(project.id)
    if (mutation === 'update') store.updateProject(project.id, { name: 'Renamed' })
    if (mutation === 'add') store.addProject({ ...store.projects[0], id: 'new', name: 'New' })
    const expected = useShellStore.getState().projects
    resolveStale(response())
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect(useShellStore.getState().projects).toEqual(expected)
    resolveFresh(response(expected))
    await vi.waitFor(() => expect(useShellStore.getState().projects).not.toBe(expected))
    await vi.waitFor(() => expect(useShellStore.getState().projects).toEqual(expected))
  })

  it('preserves project names and selection when a refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('Failed to fetch')))
    await useShellStore.getState().fetchProjects()
    await useShellStore.getState().fetchProjects()
    expect(useShellStore.getState()).toMatchObject({
      projects: [project], projectsLoaded: true, currentProjectId: project.id,
    })
  })

  it('retries a failed initial load automatically when connectivity recovers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(response()))
    await useShellStore.getState().fetchProjects()
    expect(useShellStore.getState().projectsLoaded).toBe(false)
    useApiConnectivityStore.getState().markSuccess()
    await vi.waitFor(() => expect(useShellStore.getState().projects).toMatchObject([project]))
    expect(useShellStore.getState().projectsLoaded).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reloads the list after waking even if no request reported a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
    useApiConnectivityStore.getState().markSuccess(true)
    await vi.waitFor(() => expect(useShellStore.getState().projects).toMatchObject([project]))
    useApiConnectivityStore.getState().markSuccess()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('accepts a successful empty list as authoritative', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response([])))
    await useShellStore.getState().fetchProjects()
    await useShellStore.getState().fetchProjects()
    expect(useShellStore.getState().projects).toEqual([])
    expect(useShellStore.getState().projectsLoaded).toBe(true)
  })

  it('does not let a pre-wake request overwrite the recovered list', async () => {
    let resolveOld!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(response()))
    const oldRequest = useShellStore.getState().fetchProjects()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    useApiConnectivityStore.getState().markSuccess(true)
    await vi.waitFor(() => expect(useShellStore.getState().projects).toMatchObject([project]))
    resolveOld(response([]))
    await oldRequest
    expect(useShellStore.getState().projects).toMatchObject([project])
  })
})
