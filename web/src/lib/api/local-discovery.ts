import { apiRequest } from './origin'
import type {
  DiscoveredMcpServer,
  McpDiscoverySource,
  McpServerConfig,
} from '../contracts/config'

export interface DiscoveryLocation extends McpDiscoverySource {
  kind: 'mcp' | 'skill'
  status: 'found' | 'missing' | 'error'
  count: number
  message?: string
}
export interface DiscoveredSkill {
  id: string
  name: string
  description: string
  content: string
  installed: boolean
  conflict: boolean
  sources: McpDiscoverySource[]
}
export interface LocalDiscoveryResult {
  mcp: {
    servers: DiscoveredMcpServer[]
    unsupported: Array<McpDiscoverySource & { name: string; reason: string }>
  }
  skills: DiscoveredSkill[]
  locations: DiscoveryLocation[]
}
const base = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/settings/integrations`
export const localDiscoveryApi = {
  scan: (projectId: string, directories: string[]) =>
    apiRequest<LocalDiscoveryResult>(`${base(projectId)}/discovery`, {
      method: 'POST',
      body: JSON.stringify({ directories }),
    }),
  importSkill: (projectId: string, id: string, directories: string[]) =>
    apiRequest<{ id: string; name: string }>(
      `${base(projectId)}/skills/import`,
      {
        method: 'POST',
        body: JSON.stringify({ id, directories }),
      },
    ),
}
export function mcpSignature(server: McpServerConfig): string {
  return JSON.stringify({
    ...(server.transport === "http" ? { transport: server.transport, url: server.url, headers: Object.entries(server.headers ?? {}).sort() } : {}),
    command: server.command,
    args: server.args ?? [],
    env: Object.entries(server.env ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    cwd: server.cwd ?? '',
  })
}
