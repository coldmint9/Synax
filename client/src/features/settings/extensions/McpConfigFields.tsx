import { Field, Input, Label, TextArea } from '@/shared/ui/ui/Field'
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@/shared/ui/ui/Tabs'
import { AppSelect } from '../../../shared/ui/AppSelect'
import { useLocale } from '../../../shared/hooks/useLocale'
import { useExtensionCopy } from './extension-copy'
import { mcpJsonEntries } from './mcp-config'
import type { McpDraft } from './mcp-draft'

const example = '{\n  "mcpServers": {\n    "example": {\n      "command": "npx",\n      "args": ["-y", "your-mcp-package"]\n    }\n  }\n}'

export function McpConfigFields({ draft, onChange }: { draft: McpDraft; onChange: (value: McpDraft) => void }) {
  const copy = useExtensionCopy()
  const zh = useLocale().locale.startsWith('zh')
  const manual = draft.manual
  const update = (patch: Partial<McpDraft['manual']>) => onChange({ ...draft, manual: { ...manual, ...patch } })
  let entries: Array<[string, unknown]> = []
  try { if (draft.json.trim()) entries = mcpJsonEntries(draft.json) } catch { /* Validate on test/save, not while typing. */ }
  const bare = entries.length === 1 && entries[0][0] === ''
  const raw = bare ? entries[0][1] : null
  const hasName = raw && typeof raw === 'object' && 'name' in raw && typeof raw.name === 'string' && raw.name.trim()
  return (
    <TabGroup selectedIndex={draft.method === 'json' ? 0 : 1} onChange={index => onChange({ ...draft, method: index === 0 ? 'json' : 'manual' })}>
      <TabList aria-label={zh ? 'MCP 配置方式' : 'MCP configuration method'} className="mcp-config-tabs">
        <Tab>{zh ? '粘贴 JSON' : 'Paste JSON'}</Tab>
        <Tab>{zh ? '手动填写' : 'Manual setup'}</Tab>
      </TabList>
      <TabPanels>
        <TabPanel>
          <div className="extension-form mcp-config-panel">
            <p className="extension-form-note">{zh ? '粘贴标准 mcpServers 配置或单个服务对象。包含多个服务时，选择一个添加。' : 'Paste a standard mcpServers configuration or a single server object. Select one server when multiple are included.'}</p>
            <Field>
              <Label>{zh ? 'MCP JSON 配置' : 'MCP JSON configuration'}</Label>
              <TextArea autoFocus rows={10} spellCheck={false} className="mcp-config-json" placeholder={example} value={draft.json} onChange={event => onChange({ ...draft, json: event.currentTarget.value, selectedServer: '', jsonName: '' })} />
            </Field>
            {entries.length > 1 && <AppSelect label={zh ? '要添加的服务' : 'Server to add'} value={draft.selectedServer} onChange={value => onChange({ ...draft, selectedServer: value ?? '' })} options={[{ key: '', label: zh ? '请选择一个服务' : 'Select one server' }, ...entries.map(([key]) => ({ key, label: key }))]} />}
            {bare && !hasName && <Field><Label>{copy.name}</Label><Input maxLength={128} value={draft.jsonName} onChange={event => onChange({ ...draft, jsonName: event.currentTarget.value })} /></Field>}
            {entries.length === 1 && entries[0][0] && <p className="extension-form-note">{zh ? '服务名称：' : 'Server name: '}{entries[0][0]}</p>}
          </div>
        </TabPanel>
        <TabPanel>
          <div className="extension-form mcp-config-panel">
            <Field><Label>{copy.name}</Label><Input maxLength={128} value={manual.name} onChange={event => update({ name: event.currentTarget.value })} /></Field>
            <AppSelect label={copy.mode} value={manual.transport} onChange={value => update({ transport: value as 'stdio' | 'http' })} options={[{ key: 'stdio', label: zh ? '本地命令（stdio）' : 'Local command (stdio)' }, { key: 'http', label: zh ? '远程服务（HTTP）' : 'Remote server (HTTP)' }]} />
            {manual.transport === 'stdio' ? <>
              <Field><Label>{copy.command}</Label><Input placeholder="npx / uvx / node" value={manual.command} onChange={event => update({ command: event.currentTarget.value })} /></Field>
              <Field><Label>{copy.args}</Label><TextArea rows={3} className="font-mono text-xs" value={manual.args} onChange={event => update({ args: event.currentTarget.value })} /></Field>
            </> : <Field><Label>{copy.endpoint}</Label><Input type="url" placeholder="https://example.com/mcp" value={manual.url} onChange={event => update({ url: event.currentTarget.value })} /></Field>}
            <details>
              <summary>{copy.advanced}</summary>
              <div className="extension-form">
                {manual.transport === 'stdio' ? <>
                  <Field><Label>{copy.cwd}</Label><Input value={manual.cwd} onChange={event => update({ cwd: event.currentTarget.value })} /></Field>
                  <Field><Label>{copy.env}</Label><TextArea className="font-mono text-xs" value={manual.env} onChange={event => update({ env: event.currentTarget.value })} /></Field>
                </> : <Field><Label>{copy.headers}</Label><TextArea className="font-mono text-xs" value={manual.headers} onChange={event => update({ headers: event.currentTarget.value })} /></Field>}
              </div>
            </details>
          </div>
        </TabPanel>
      </TabPanels>
      <details className="mcp-config-description">
        <summary>{zh ? '用途说明（可选）' : 'Description (optional)'}</summary>
        <Field><Label className="sr-only">{copy.description}</Label><Input maxLength={4000} value={draft.description} onChange={event => onChange({ ...draft, description: event.currentTarget.value })} /></Field>
      </details>
    </TabGroup>
  )
}
