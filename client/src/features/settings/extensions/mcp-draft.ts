import type { McpServerConfig } from '../../../shared/contracts/config'
import { mcpJsonEntries, stringMap, validateMcp } from './mcp-config'

export type McpDraft = {
  method: 'json' | 'manual'
  json: string
  selectedServer: string
  jsonName: string
  description: string
  manual: {
    name: string
    transport: 'stdio' | 'http'
    command: string
    args: string
    url: string
    cwd: string
    env: string
    headers: string
    enabled?: boolean
  }
}

export function createMcpDraft(config?: McpServerConfig, name = '', description = ''): McpDraft {
  return {
    method: config ? 'manual' : 'json',
    json: config ? JSON.stringify({ mcpServers: { [name || config.name]: { ...config, id: undefined, name: undefined } } }, null, 2) : '',
    selectedServer: '', jsonName: '', description,
    manual: {
      name: name || config?.name || '', transport: config?.transport === 'http' ? 'http' : 'stdio',
      command: config?.command ?? '', args: (config?.args ?? []).join('\n'), url: config?.url ?? '',
      cwd: config?.cwd ?? '', env: JSON.stringify(config?.env ?? {}, null, 2),
      headers: JSON.stringify(config?.headers ?? {}, null, 2), enabled: config?.enabled,
    },
  }
}

export function readMcpDraft(draft: McpDraft, id?: string) {
  if (draft.description.trim().length > 4000) throw new Error('Description exceeds 4000 characters / 用途说明不能超过 4000 个字符')
  let name: string
  let value: unknown
  if (draft.method === 'json') {
    const entries = mcpJsonEntries(draft.json)
    const selected = entries.length === 1 ? entries[0] : entries.find(([key]) => key === draft.selectedServer)
    if (!selected) throw new Error('Select one MCP server / 请选择一个 MCP 服务')
    const [key, raw] = selected
    const rawName = raw && typeof raw === 'object' && 'name' in raw && typeof raw.name === 'string' ? raw.name : ''
    name = key || draft.jsonName.trim() || rawName
    value = raw
  } else {
    const manual = draft.manual
    name = manual.name.trim()
    value = manual.transport === 'http'
      ? { transport: 'http', url: manual.url.trim(), headers: stringMap(manual.headers), enabled: manual.enabled }
      : { transport: 'stdio', command: manual.command.trim(), args: manual.args.split('\n').map(arg => arg.trim()).filter(Boolean), env: stringMap(manual.env), ...(manual.cwd.trim() ? { cwd: manual.cwd.trim() } : {}), enabled: manual.enabled }
  }
  const mcp = validateMcp(value, name, id)
  return { name: mcp.name, description: draft.description.trim(), mcp }
}
