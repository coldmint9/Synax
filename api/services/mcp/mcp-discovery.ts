import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import type { McpServerConfig } from '../../lib/config/config-types.js'

const MAX_CONFIG_BYTES = 1024 * 1024

type DiscoveryScope = 'project' | 'user'
type ConfigFormat = 'standard' | 'vscode' | 'opencode' | 'codex' | 'claude-user'

interface ConfigLocation {
  client: string
  filePath: string
  format: ConfigFormat
  scope: DiscoveryScope
  workspaceDirectory?: string
}

interface EntryGroup {
  entries: Record<string, unknown>
  scope: DiscoveryScope
}

export interface McpDiscoverySource {
  client: string
  path: string
  scope: DiscoveryScope
}

export interface DiscoveredMcpServer {
  fingerprint: string
  server: McpServerConfig
  sources: McpDiscoverySource[]
}

export interface McpDiscoveryWarning {
  client: string
  path: string
  message: string
}

export interface McpDiscoveryResult {
  servers: DiscoveredMcpServer[]
  scannedFiles: number
  warnings: McpDiscoveryWarning[]
  locations: Array<McpDiscoverySource & { kind: 'mcp'; status: 'found' | 'missing' | 'error'; count: number; message?: string }>
  unsupported: Array<McpDiscoverySource & { name: string; reason: string }>
}

export interface McpDiscoveryOptions {
  homeDir?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  extraDirectories?: string[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function primitiveStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof item))
    .map(String)
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const entries = Object.entries(record)
    .filter((entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1]))
    .map(([key, item]) => [key, String(item)] as const)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function normalizeWorkingDirectory(value: unknown, projectDirectory: string | undefined, homeDir: string): string | undefined {
  const fallback = projectDirectory ? path.resolve(projectDirectory) : undefined
  if (typeof value !== 'string' || !value.trim()) return fallback

  let cwd = value.trim()
  if (fallback) cwd = cwd.replace(/\$\{(?:workspaceFolder|workspaceRoot)\}/g, fallback)
  cwd = cwd.replace(/\$\{userHome\}/g, homeDir)
  if (cwd === '~') cwd = homeDir
  else if (cwd.startsWith(`~${path.sep}`)) cwd = path.join(homeDir, cwd.slice(2))
  if (!path.isAbsolute(cwd) && !cwd.includes('${') && fallback) cwd = path.resolve(fallback, cwd)
  return cwd
}

function normalizeServer(
  name: string,
  value: unknown,
  projectDirectory: string | undefined,
  homeDir: string,
): Omit<McpServerConfig, 'id'> | null {
  const record = asRecord(value)
  if (!record) return null

  const type = typeof record.type === 'string' ? record.type.toLowerCase() : ''
  if (['http', 'sse', 'remote', 'streamable-http'].includes(type)) return null

  let command = ''
  let args: string[] = []
  if (typeof record.command === 'string') {
    command = record.command.trim()
    args = primitiveStrings(record.args)
  } else if (Array.isArray(record.command)) {
    const commandParts = primitiveStrings(record.command)
    command = commandParts[0]?.trim() ?? ''
    args = commandParts.slice(1)
  } else {
    const commandRecord = asRecord(record.command)
    if (commandRecord && typeof commandRecord.path === 'string') {
      command = commandRecord.path.trim()
      args = primitiveStrings(commandRecord.args)
    }
  }

  if (!command || command.includes('\0')) return null
  const env = stringMap(record.env ?? record.environment)
  const cwd = normalizeWorkingDirectory(record.cwd, projectDirectory, homeDir)
  return {
    name: name.trim() || command,
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    enabled: record.enabled !== false && record.disabled !== true,
  }
}

function serverFingerprint(server: Omit<McpServerConfig, 'id' | 'name' | 'enabled'>): string {
  const sortedEnv = server.env
    ? Object.fromEntries(Object.entries(server.env).sort(([a], [b]) => a.localeCompare(b)))
    : undefined
  return createHash('sha256')
    .update(JSON.stringify({ command: server.command, args: server.args ?? [], env: sortedEnv ?? {}, cwd: server.cwd ?? '' }))
    .digest('hex')
    .slice(0, 16)
}

function discoveredId(name: string, fingerprint: string): string {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'server'
  return `discovered-${slug}-${fingerprint.slice(0, 10)}`
}

function parseConfig(location: ConfigLocation, text: string): unknown {
  if (location.format === 'codex') return parseToml(text)
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown
  if (errors.length > 0) {
    const first = errors[0]
    throw new Error(`Invalid JSON near offset ${first.offset}`)
  }
  return parsed
}

function entryGroups(location: ConfigLocation, parsed: unknown, projectDirectory?: string): EntryGroup[] {
  const root = asRecord(parsed)
  if (!root) return []

  if (location.format === 'standard') {
    const entries = asRecord(root.mcpServers)
    return entries ? [{ entries, scope: location.scope }] : []
  }
  if (location.format === 'vscode') {
    const entries = asRecord(root.servers)
    return entries ? [{ entries, scope: location.scope }] : []
  }
  if (location.format === 'opencode') {
    const entries = asRecord(root.mcp)
    return entries ? [{ entries, scope: location.scope }] : []
  }
  if (location.format === 'codex') {
    const entries = asRecord(root.mcp_servers)
    return entries ? [{ entries, scope: location.scope }] : []
  }

  const groups: EntryGroup[] = []
  const userEntries = asRecord(root.mcpServers)
  if (userEntries) groups.push({ entries: userEntries, scope: 'user' })
  if (!projectDirectory) return groups

  const projects = asRecord(root.projects)
  if (!projects) return groups
  const target = path.resolve(projectDirectory)
  for (const [projectPath, projectValue] of Object.entries(projects)) {
    if (path.resolve(projectPath) !== target) continue
    const projectEntries = asRecord(asRecord(projectValue)?.mcpServers)
    if (projectEntries) groups.push({ entries: projectEntries, scope: 'project' })
  }
  return groups
}

function displayPath(filePath: string, homeDir: string, projectDirectory?: string): string {
  const resolved = path.resolve(filePath)
  if (projectDirectory) {
    const project = path.resolve(projectDirectory)
    const relative = path.relative(project, resolved)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return `./${relative}`
  }
  const relativeHome = path.relative(path.resolve(homeDir), resolved)
  if (relativeHome && !relativeHome.startsWith('..') && !path.isAbsolute(relativeHome)) return `~/${relativeHome}`
  return resolved
}

function editorUserDirectory(
  appName: string,
  homeDir: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', appName, 'User')
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), appName, 'User')
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), appName, 'User')
}

function configLocations(projectDirectory: string | undefined, options: McpDiscoveryOptions): ConfigLocation[] {
  const homeDir = options.homeDir ?? os.homedir()
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(homeDir, '.config')
  const locations: ConfigLocation[] = []
  const add = (client: string, filePath: string, format: ConfigFormat, scope: DiscoveryScope) => {
    locations.push({ client, filePath, format, scope, ...(scope === 'project' ? { workspaceDirectory: projectDirectory } : {}) })
  }

  if (projectDirectory) {
    add('Claude Code', path.join(projectDirectory, '.mcp.json'), 'standard', 'project')
    add('Cursor', path.join(projectDirectory, '.cursor', 'mcp.json'), 'standard', 'project')
    add('VS Code', path.join(projectDirectory, '.vscode', 'mcp.json'), 'vscode', 'project')
    add('Windsurf', path.join(projectDirectory, '.windsurf', 'mcp_config.json'), 'standard', 'project')
    add('Roo Code', path.join(projectDirectory, '.roo', 'mcp.json'), 'standard', 'project')
    add('Kilo Code', path.join(projectDirectory, '.kilocode', 'mcp.json'), 'standard', 'project')
    add('OpenCode', path.join(projectDirectory, 'opencode.json'), 'opencode', 'project')
    add('OpenCode', path.join(projectDirectory, 'opencode.jsonc'), 'opencode', 'project')
    add('OpenCode', path.join(projectDirectory, '.opencode', 'opencode.json'), 'opencode', 'project')
    add('OpenCode', path.join(projectDirectory, '.opencode', 'opencode.jsonc'), 'opencode', 'project')
    add('Codex', path.join(projectDirectory, '.codex', 'config.toml'), 'codex', 'project')
    add('Gemini CLI', path.join(projectDirectory, '.gemini', 'settings.json'), 'standard', 'project')
  }

  add('Claude Code', path.join(homeDir, '.claude.json'), 'claude-user', 'user')
  if (env.CLAUDE_CONFIG_DIR) add('Claude Code', path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), 'claude-user', 'user')
  add('Claude Code', path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), 'settings.json'), 'standard', 'user')
  if (platform === 'darwin') {
    add('Claude Desktop', path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'standard', 'user')
  } else if (platform === 'win32') {
    add('Claude Desktop', path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'), 'standard', 'user')
  } else {
    add('Claude Desktop', path.join(xdgConfig, 'Claude', 'claude_desktop_config.json'), 'standard', 'user')
    add('Claude Desktop', path.join(xdgConfig, 'claude', 'claude_desktop_config.json'), 'standard', 'user')
  }
  add('Cursor', path.join(homeDir, '.cursor', 'mcp.json'), 'standard', 'user')
  add('Windsurf', path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'), 'standard', 'user')
  add('OpenCode', path.join(xdgConfig, 'opencode', 'opencode.json'), 'opencode', 'user')
  add('OpenCode', path.join(xdgConfig, 'opencode', 'opencode.jsonc'), 'opencode', 'user')
  add('Codex', path.join(env.CODEX_HOME || path.join(homeDir, '.codex'), 'config.toml'), 'codex', 'user')
  add('Gemini CLI', path.join(homeDir, '.gemini', 'settings.json'), 'standard', 'user')

  const editorApps = [
    ['VS Code', 'Code'],
    ['VS Code Insiders', 'Code - Insiders'],
    ['VSCodium', 'VSCodium'],
    ['Cursor', 'Cursor'],
  ] as const
  for (const [client, appName] of editorApps) {
    const userDir = editorUserDirectory(appName, homeDir, platform, env)
    add(client, path.join(userDir, 'mcp.json'), 'vscode', 'user')
    add('Cline', path.join(userDir, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), 'standard', 'user')
    add('Roo Code', path.join(userDir, 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'), 'standard', 'user')
    add('Kilo Code', path.join(userDir, 'globalStorage', 'kilocode.kilo-code', 'settings', 'mcp_settings.json'), 'standard', 'user')
  }

  for (const directory of options.extraDirectories ?? []) {
    for (const location of configLocations(directory, { ...options, extraDirectories: [] })) {
      if (location.scope === 'project') locations.push(location)
    }
    locations.push({ client: 'Custom', filePath: path.join(directory, 'mcp.json'), format: 'standard', scope: 'user', workspaceDirectory: directory })
    locations.push({ client: 'Codex', filePath: path.join(directory, 'config.toml'), format: 'codex', scope: 'user', workspaceDirectory: directory })
  }

  const unique = new Map<string, ConfigLocation>()
  for (const location of locations) unique.set(`${location.format}\0${path.resolve(location.filePath)}`, location)
  return [...unique.values()]
}

export function discoverLocalMcpServers(
  projectDirectory?: string,
  options: McpDiscoveryOptions = {},
): McpDiscoveryResult {
  const homeDir = options.homeDir ?? os.homedir()
  const discovered = new Map<string, DiscoveredMcpServer>()
  const warnings: McpDiscoveryWarning[] = []
  let scannedFiles = 0
  const locations: McpDiscoveryResult['locations'] = []
  const unsupported: McpDiscoveryResult['unsupported'] = []

  for (const location of configLocations(projectDirectory, options)) {
    const sourcePath = displayPath(location.filePath, homeDir, projectDirectory)
    const report: McpDiscoveryResult['locations'][number] = { client: location.client, path: sourcePath, scope: location.scope, kind: 'mcp', status: 'missing', count: 0 }
    locations.push(report)
    if (!fs.existsSync(location.filePath)) continue
    try {
      const stat = fs.statSync(location.filePath)
      if (!stat.isFile()) continue
      if (stat.size > MAX_CONFIG_BYTES) throw new Error('Configuration file is larger than 1 MB')
      report.status = 'found'
      scannedFiles += 1
      const parsed = parseConfig(location, fs.readFileSync(location.filePath, 'utf8'))
      for (const group of entryGroups(location, parsed, projectDirectory)) {
        for (const [name, value] of Object.entries(group.entries)) {
          const normalized = normalizeServer(name, value, location.workspaceDirectory ?? projectDirectory, homeDir)
          if (!normalized) {
            unsupported.push({ client: location.client, path: sourcePath, scope: group.scope, name, reason: asRecord(value)?.url ? 'HTTP / SSE transport is not supported yet' : 'Missing or unsupported launch command' })
            continue
          }
          report.count++
          const fingerprint = serverFingerprint(normalized)
          const source = { client: location.client, path: sourcePath, scope: group.scope }
          const existing = discovered.get(fingerprint)
          if (existing) {
            if (!existing.sources.some(item => item.client === source.client && item.path === source.path && item.scope === source.scope)) {
              existing.sources.push(source)
            }
            continue
          }
          discovered.set(fingerprint, {
            fingerprint,
            server: {
              id: discoveredId(normalized.name, fingerprint),
              ...normalized,
            },
            sources: [source],
          })
        }
      }
    } catch (error) {
      report.status = 'error'
      report.message = error instanceof Error ? error.message : String(error)
      warnings.push({
        client: location.client,
        path: sourcePath,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    servers: [...discovered.values()].sort((a, b) => a.server.name.localeCompare(b.server.name)),
    scannedFiles,
    warnings,
    locations,
    unsupported,
  }
}
