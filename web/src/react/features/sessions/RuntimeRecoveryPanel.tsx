import { useState } from 'react'
import { agentRuntimeApi, type AgentSession } from '../../../lib/api/agentRuntime'
import { useAgentSessionStore } from './agentSessionStore'
import { useLocale } from '../../../hooks/useLocale'

export function RuntimeRecoveryPanel({ session }: { session: AgentSession }) {
  const { locale } = useLocale(); const zh = locale === 'zh'
  const [reviewed, setReviewed] = useState(false), [stopped, setStopped] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const control = session.sessionMetadata?.runtimeControl as { state?: string; reason?: string } | undefined
  if (control?.state !== 'unconfirmed') return null
  return <section aria-label={zh ? '执行恢复' : 'Execution recovery'} className="mb-3 space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs">
    <p className="font-medium">{zh ? '恢复前需要检查' : 'Review required before recovery'}</p>
    <p className="text-muted-foreground">{control.reason}</p>
    <label className="flex items-start gap-2"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
      {zh ? '我已检查中断涉及的文件与 Git 变更。' : 'I reviewed the affected files and Git changes.'}</label>
    <label className="flex items-start gap-2"><input type="checkbox" checked={stopped} onChange={event => setStopped(event.target.checked)} />
      {zh ? '确认旧执行已停止；服务仍会核验已登记的进程。' : 'The old execution is stopped; recorded processes will still be checked.'}</label>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <button type="button" disabled={!reviewed || !stopped || busy} className="rounded-md bg-secondary px-3 py-1.5 disabled:opacity-40" onClick={() => {
      setBusy(true); setError(null)
      void agentRuntimeApi.acknowledgeRecovery(session.id).then(({ session: updated }) => {
        const store = useAgentSessionStore.getState(); store.patchSession(session.id, updated)
        void store.refreshSessions(); void store.refreshDetail()
      }).catch(cause => setError(cause instanceof Error ? cause.message : 'Recovery failed.')).finally(() => setBusy(false))
    }}>{busy ? (zh ? '正在核验…' : 'Checking…') : (zh ? '解除恢复阻塞（不自动执行）' : 'Release recovery block (does not run work)')}</button>
  </section>
}
