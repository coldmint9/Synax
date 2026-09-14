import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { enableRuntimeAuth, ensureRuntimeAuthentication, RUNTIME_AUTH_REQUIRED, setRuntimeAccessToken } from '../../../lib/api/runtimeAuth'
import { useApiConnectivityStore } from '../../../lib/apiConnectivity'
import { useLocale } from '../../../hooks/useLocale'

export function RuntimeAccessGate({ children }: { children: ReactNode }) {
  const { locale } = useLocale(); const zh = locale === 'zh'
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null); const [token, setToken] = useState('')
  const connect = useCallback(async () => {
    enableRuntimeAuth(); setBusy(true); setError(null)
    try { await ensureRuntimeAuthentication(); useApiConnectivityStore.getState().markSuccess(); setReady(true); setToken('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Runtime unavailable.'); setReady(false) }
    finally { setBusy(false) }
  }, [])
  useEffect(() => { void connect(); const invalidated = () => { setReady(false); void connect() }
    window.addEventListener(RUNTIME_AUTH_REQUIRED, invalidated)
    return () => window.removeEventListener(RUNTIME_AUTH_REQUIRED, invalidated)
  }, [connect])
  if (ready) return children
  return <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
    <form className="w-full max-w-sm space-y-4" onSubmit={event => { event.preventDefault(); if (token) setRuntimeAccessToken(token); void connect() }}>
      <h1 className="text-lg font-semibold">Synax Runtime</h1>
      <p className="text-sm text-muted-foreground">{busy ? (zh ? '正在连接运行服务…' : 'Connecting to the runtime…') : (zh ? '需要连接授权的运行服务。令牌仅保留在本次页面内存中。' : 'Connect to an authorized runtime. Tokens are kept only in this page’s memory.')}</p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {!busy && <><label className="block text-sm">{zh ? 'Runtime 访问令牌（非模型 API Key）' : 'Runtime access token (not a model API key)'}
        <input type="password" autoComplete="off" aria-label="Runtime access token" value={token} onChange={event => setToken(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3" />
      </label><button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">{zh ? '连接 / 重试' : 'Connect / retry'}</button></>}
    </form>
  </main>
}
