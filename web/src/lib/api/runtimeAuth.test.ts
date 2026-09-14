import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
beforeEach(() => vi.resetModules())
afterEach(() => { vi.unstubAllGlobals(); delete (window as unknown as { electronAPI?: unknown }).electronAPI })

describe('runtime authentication client', () => {
  it('uses desktop IPC credentials only in headers and coalesces bootstrap requests', async () => {
    const token = 'a'.repeat(64)
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { getRuntimeToken: vi.fn(async () => token) }
    const fetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ authenticated: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const auth = await import('./runtimeAuth')
    auth.enableRuntimeAuth()
    await Promise.all([auth.ensureRuntimeAuthentication(), auth.ensureRuntimeAuthentication()])
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain(token)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`)
    expect(init.body).not.toContain(token)
  })
  it('does not send runtime credentials to a foreign API origin', async () => {
    const auth = await import('./runtimeAuth'); auth.setRuntimeAccessToken('b'.repeat(64))
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const { setApiOriginForTests } = await import('./originConfig'); setApiOriginForTests('http://localhost:3210')
    const { apiFetch } = await import('./origin')
    await expect(apiFetch('https://foreign.example/api/test')).rejects.toThrow(/another origin/)
    expect(fetch).not.toHaveBeenCalled()
  })
})
