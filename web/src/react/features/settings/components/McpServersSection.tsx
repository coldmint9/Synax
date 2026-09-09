import { useEffect, useState } from 'react'
import { Button, Checkbox } from '@heroui/react'
import { Plug, Plus, Trash2, Pencil, Wifi, Loader2, X } from 'lucide-react'
import { SettingsCard } from './SettingsCard'
import { SaveIndicator } from './SaveIndicator'
import { configApi } from '../../../../lib/api/config'
import type { GlobalConfig, McpServerConfig } from '../../../../lib/contracts/config'
import { useLocale } from '../../../../hooks/useLocale'

interface Props {
  config: GlobalConfig
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
}

type Draft = {
  id: string
  name: string
  command: string
  argsText: string
  envText: string
  enabled: boolean
}

function emptyDraft(id: string): Draft {
  return { id, name: '', command: '', argsText: '', envText: '', enabled: true }
}

function draftToConfig(draft: Draft): McpServerConfig {
  const args = draft.argsText
    .split(/\n|,/g)
    .map(a => a.trim())
    .filter(Boolean)
  const env: Record<string, string> = {}
  for (const line of draft.envText.split('\n')) {
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) env[key] = value
  }
  return {
    id: draft.id,
    name: draft.name.trim(),
    command: draft.command.trim(),
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(draft.enabled ? {} : { enabled: false }),
  }
}

function configToDraft(server: McpServerConfig): Draft {
  return {
    id: server.id,
    name: server.name,
    command: server.command,
    argsText: (server.args ?? []).join('\n'),
    envText: Object.entries(server.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    enabled: server.enabled !== false,
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `mcp-${crypto.randomUUID().slice(0, 8)}`
  return `mcp-${Date.now().toString(36)}`
}

export function McpServersSection({ config, onUpdate }: Props) {
  const { t } = useLocale()
  const [servers, setServers] = useState<McpServerConfig[]>(config.mcpServers ?? [])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)

  useEffect(() => {
    setServers(config.mcpServers ?? [])
  }, [config.mcpServers])
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testMessages, setTestMessages] = useState<Record<string, string>>({})

  async function persist(next: McpServerConfig[]) {
    setSaving(true)
    setSaveError(null)
    try {
      await onUpdate({ mcpServers: next })
      setServers(next)
      setSaved(true)
      setTimeout(() => setSaved(false), 1200)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(server: McpServerConfig) {
    setTestingId(server.id)
    setTestMessages(m => ({ ...m, [server.id]: '正在连接…' }))
    try {
      const result = await configApi.testMcpServer(server)
      if (result.ok) {
        setTestMessages(m => ({
          ...m,
          [server.id]: `✓ 连接成功，发现 ${result.tools.length} 个工具：${result.tools.slice(0, 8).map(t => t.name).join(', ') || '—'}`,
        }))
      } else {
        setTestMessages(m => ({ ...m, [server.id]: `✗ ${result.error ?? '连接失败'}` }))
      }
    } catch (err) {
      setTestMessages(m => ({ ...m, [server.id]: `✗ ${err instanceof Error ? err.message : '连接失败'}` }))
    } finally {
      setTestingId(null)
    }
  }

  function handleToggleEnabled(server: McpServerConfig, enabled: boolean) {
    const next = servers.map(s => (s.id === server.id ? { ...s, ...(enabled ? {} : { enabled: false }) } : s))
    void persist(next)
  }

  function handleSaveDraft() {
    if (!editing) return
    if (!editing.name.trim() || !editing.command.trim()) {
      setSaveError('名称与命令不能为空')
      return
    }
    const configDraft = draftToConfig(editing)
    const next = servers.some(s => s.id === editing.id)
      ? servers.map(s => (s.id === editing.id ? configDraft : s))
      : [...servers, configDraft]
    setEditing(null)
    void persist(next)
  }

  function handleDelete(id: string) {
    void persist(servers.filter(s => s.id !== id))
    if (editing?.id === id) setEditing(null)
  }

  return (
    <SettingsCard
      title={t('settingsMcpTitle')}
      icon={Plug}
      trailing={
        <div className="flex items-center gap-2">
          <SaveIndicator saving={saving} saved={saved} error={saveError} />
          <Button
            size="sm"
            variant="secondary"
            className="wh-pill-btn wh-pill-btn--soft wh-pill-btn--sm"
            onPress={() => setEditing(emptyDraft(randomId()))}
          >
            <Plus size={12} />
            添加服务器
          </Button>
        </div>
      }
    >
      <p className="text-xs text-muted-foreground pb-2">{t('settingsMcpDesc')}</p>
      {servers.length === 0 && !editing && (
        <p className="text-xs text-muted-foreground py-2">尚未配置 MCP 服务器。添加 stdio 服务器后可在 agent 输入框按会话启用。</p>
      )}
      <div className="space-y-2">
        {servers.map(server => (
          <div key={server.id} className="settings-item overflow-hidden">
            <div className="flex items-start gap-3 p-3">
              <Checkbox
                isSelected={server.enabled !== false}
                onChange={(checked) => handleToggleEnabled(server, Boolean(checked))}
                aria-label={`启用 ${server.name}`}
              >
                <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              </Checkbox>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">{server.name}</span>
                  {server.enabled === false && <span className="settings-chip settings-chip--muted">已停用</span>}
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {server.command} {server.args?.join(' ') ?? ''}
                </div>
                {testMessages[server.id] && (
                  <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{testMessages[server.id]}</div>
                )}
                <div className="mt-2 flex items-center gap-1.5">
                  <Button size="sm" variant="secondary" onPress={() => { setEditing(configToDraft(server)); setSaveError(null) }}>
                    <Pencil size={12} /> 编辑
                  </Button>
                  <Button size="sm" variant="secondary" isPending={testingId === server.id} onPress={() => void handleTest(server)}>
                    {({ isPending }) => (
                      <>{isPending ? null : <Wifi size={12} />}测试连接</>
                    )}
                  </Button>
                  <Button size="sm" variant="danger-soft" onPress={() => handleDelete(server.id)}>
                    <Trash2 size={12} /> 删除
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <div className="mt-3 space-y-3 rounded-lg border border-border/40 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">{servers.some(s => s.id === editing.id) ? '编辑 MCP 服务器' : '新增 MCP 服务器'}</span>
            <Button isIconOnly size="sm" variant="ghost" aria-label="关闭" onPress={() => setEditing(null)}>
              <X size={13} />
            </Button>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-foreground">名称</span>
            <input
              className="import-input w-full"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="例如 Filesystem"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-foreground">命令</span>
            <input
              className="import-input w-full font-mono"
              value={editing.command}
              onChange={(e) => setEditing({ ...editing, command: e.target.value })}
              placeholder="npx / 可执行文件路径"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-foreground">参数（每行一个）</span>
            <textarea
              className="import-input w-full font-mono"
              rows={3}
              value={editing.argsText}
              onChange={(e) => setEditing({ ...editing, argsText: e.target.value })}
              placeholder="-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-foreground">环境变量（KEY=VALUE，每行一个）</span>
            <textarea
              className="import-input w-full font-mono"
              rows={3}
              value={editing.envText}
              onChange={(e) => setEditing({ ...editing, envText: e.target.value })}
              placeholder="API_KEY=sk-xxx"
            />
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              isSelected={editing.enabled}
              onChange={(checked) => setEditing({ ...editing, enabled: Boolean(checked) })}
            >
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            </Checkbox>
            <span className="text-xs text-foreground">启用该服务器（可在 agent 输入框按会话选择）</span>
          </label>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button size="sm" variant="secondary" onPress={() => {
              const probe = draftToConfig(editing)
              if (!probe.command) return
              setTestingId(probe.id)
              void configApi.testMcpServer(probe).then((result) => {
                setTestMessages(m => ({
                  ...m,
                  [probe.id]: result.ok
                    ? `✓ 连接成功，发现 ${result.tools.length} 个工具`
                    : `✗ ${result.error ?? '连接失败'}`,
                }))
              }).finally(() => setTestingId(null))
            }}>
              {testingId === editing.id ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />}
              测试连接
            </Button>
            <Button size="sm" onPress={handleSaveDraft}>保存</Button>
          </div>
        </div>
      )}
    </SettingsCard>
  )
}
