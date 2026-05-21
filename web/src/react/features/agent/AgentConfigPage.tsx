// ── DEPRECATED (2026-04-28) ───────────────────────────────────────────────
// 本页面已废弃，替换为 web/src/react/features/settings/ConfigPage.tsx。
// 路由已重定向：/settings/agent → ConfigPage
// 保留文件以便 Git 历史追踪，新功能请在 ConfigPage 中实现。
// ────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { aiIntegrationApi } from '../../../lib/api/ai-integration'
import { useShellStore } from '../../state/shellStore'
import { useAiIntegrations } from './useAiIntegrations'

export default function AgentConfigPage() {
  const user = useShellStore(s => s.currentUser)
  const { integrations, bindings, loading, reload } = useAiIntegrations()
  const [name, setName] = useState('Custom Provider')
  const [model, setModel] = useState('gpt-4.1')
  const [projectId, setProjectId] = useState('rumbling-core')
  const [agentKey, setAgentKey] = useState('opencode-acp')

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <Link
          to="/"
          className="mb-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft size={14} />
          返回首页
        </Link>
        <h1 className="text-2xl font-semibold">Agent 配置</h1>
        <div className="mt-4 space-y-4">
          <section className="rounded-xl border border-border/60 bg-card p-4">
            <h2 className="text-sm font-semibold">创建集成</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <input className="h-10 rounded-md border border-border bg-background px-3 text-sm" value={name} onChange={e => setName(e.target.value)} />
              <input className="h-10 rounded-md border border-border bg-background px-3 text-sm" value={model} onChange={e => setModel(e.target.value)} />
              <button
                className="h-10 rounded-md bg-primary text-sm text-primary-foreground"
                onClick={async () => {
                  await aiIntegrationApi.create({
                    provider: 'openai',
                    name,
                    model,
                    baseUrl: 'https://api.openai.com',
                    apiKey: 'sk-prototype',
                  }, user.name)
                  await reload()
                }}
              >
                添加
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-border/60 bg-card p-4">
            <h2 className="text-sm font-semibold">集成列表</h2>
            {loading ? (
              <p className="mt-2 text-sm text-muted-foreground">加载中…</p>
            ) : (
              <div className="mt-2 space-y-2">
                {integrations.map(item => (
                  <div key={item.id} className="flex items-center justify-between rounded-md border border-border/50 p-2 text-sm">
                    <div>
                      <div className="font-medium">{item.name}</div>
                      <div className="text-xs text-muted-foreground">{item.provider} · {item.model}</div>
                    </div>
                    <div className="flex gap-2">
                      <button className="rounded border border-border px-2 py-1 text-xs" onClick={async () => { await aiIntegrationApi.setDefault(item.id); await reload() }}>默认</button>
                      <button className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive" onClick={async () => { await aiIntegrationApi.remove(item.id); await reload() }}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-border/60 bg-card p-4">
            <h2 className="text-sm font-semibold">Agent 绑定</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <input className="h-10 rounded-md border border-border bg-background px-3 text-sm" value={projectId} onChange={e => setProjectId(e.target.value)} />
              <input className="h-10 rounded-md border border-border bg-background px-3 text-sm" value={agentKey} onChange={e => setAgentKey(e.target.value)} />
              <select className="h-10 rounded-md border border-border bg-background px-3 text-sm" id="integration-picker">
                {integrations.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
              <button
                className="h-10 rounded-md bg-primary text-sm text-primary-foreground disabled:opacity-50"
                disabled={integrations.length === 0}
                onClick={async () => {
                  const integrationId = (document.getElementById('integration-picker') as HTMLSelectElement)?.value
                  if (!integrationId) return
                  await aiIntegrationApi.upsertBinding({
                    projectId,
                    roleType: 'developer',
                    agentKey,
                    integrationId,
                  }, user.name)
                  await reload()
                }}
              >
                绑定
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {bindings.map(b => (
                <div key={b.id} className="flex items-center justify-between rounded-md border border-border/50 p-2 text-sm">
                  <span>{b.projectId} · {b.roleType} · {b.agentKey}</span>
                  <button className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive" onClick={async () => { await aiIntegrationApi.removeBinding(b.id); await reload() }}>
                    解除绑定
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
