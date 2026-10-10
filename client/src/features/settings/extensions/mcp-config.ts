import { mcpExtensionSchema } from '../../../../../services/local-node/modules/extensions/schemas'
import type { McpServerConfig } from '../../../shared/contracts/config'

export function mcpJsonEntries(text: string): Array<[string, unknown]> {
  let parsed: unknown
  try { parsed = JSON.parse(text) }
  catch { throw new Error('Invalid JSON / JSON 格式无效，请检查') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object / 请填写 JSON 对象')
  const object = parsed as Record<string, unknown>
  if ('mcpServers' in object) {
    if (!object.mcpServers || typeof object.mcpServers !== 'object' || Array.isArray(object.mcpServers)) throw new Error('mcpServers must be an object / mcpServers 必须是对象')
    const entries = Object.entries(object.mcpServers)
    if (!entries.length) throw new Error('mcpServers is empty / 请至少提供一个服务')
    return entries
  }
  return [['', object]]
}

export function validateMcp(value: unknown, name: string, id = 'custom-preview'): McpServerConfig {
  if (!name.trim() || name.trim().length > 128) throw new Error('Name must contain 1–128 characters / 名称需要 1–128 个字符')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MCP configuration / MCP 配置必须是对象')
  const raw = value as Record<string, unknown>
  const type = raw.transport ?? raw.type
  if (type !== undefined && !['stdio', 'http', 'streamable-http'].includes(String(type))) throw new Error('Supported transports: stdio, http, streamable-http / 不支持该接入方式')
  if (raw.command && raw.url) throw new Error('Use either command or url / command 和 url 只能填写一种')
  const transport = type === 'stdio' ? 'stdio' : type === 'http' || type === 'streamable-http' || raw.url !== undefined ? 'http' : 'stdio'
  const normalized = { ...raw, id, name: name.trim(), transport, command: transport === 'http' ? '' : raw.command }
  if (transport === 'http' && raw.command) throw new Error('HTTP configuration cannot include command / HTTP 配置不能包含 command')
  if (transport === 'stdio' && raw.url) throw new Error('stdio configuration cannot include url / 本地命令配置不能包含 url')
  const result = mcpExtensionSchema.safeParse(normalized)
  if (!result.success) throw new Error(result.error.issues.map(issue => `${issue.path.join('.') || '配置'}: ${issue.message}`).join('\n'))
  return result.data
}

export function stringMap(text: string): Record<string, string> {
  const value: unknown = JSON.parse(text.trim() || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) throw new Error('Expected an object with string values / 请填写字符串键值对 JSON 对象')
  return value as Record<string, string>
}
