import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'
import {
  discoverLocalMcpServers,
  type McpDiscoveryOptions,
  type McpDiscoverySource,
} from '../mcp/mcp-discovery.js'
import { parseSkillFile } from '../skills/skill-parser.js'

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
export interface LocalDiscoveryOptions extends McpDiscoveryOptions {
  extraDirectories?: string[]
}

function shortPath(file: string, home: string, project?: string): string {
  for (const [root, prefix] of [
    [project, '.'],
    [home, '~'],
  ]) {
    if (!root) continue
    const relative = path.relative(root, file)
    if (
      relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
      return `${prefix}/${relative}`
  }
  return file
}

/** Scan known tool directories only. Never traverse arbitrary home/project trees. */
export function discoverLocalIntegrations(
  project?: string,
  options: LocalDiscoveryOptions = {},
) {
  const home = options.homeDir ?? os.homedir()
  const env = options.env ?? process.env
  const mcp = discoverLocalMcpServers(project, options)
  const locations: DiscoveryLocation[] = [...mcp.locations]
  const found = new Map<string, DiscoveredSkill>()
  const paths = new Map<string, string>()
  const roots: Array<{
    client: string
    directory: string
    scope: 'project' | 'user'
    depth: number
  }> = []
  const add = (
    client: string,
    directory: string,
    scope: 'project' | 'user',
    depth = 1,
  ) => roots.push({ client, directory, scope, depth })
  const codexHome = env.CODEX_HOME || path.join(home, '.codex')
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  for (const [client, directory] of [
    ['Claude Code', path.join(claudeHome, 'skills')],
    ['Codex', path.join(codexHome, 'skills')],
    ['Agents', path.join(home, '.agents', 'skills')],
    ['Cursor', path.join(home, '.cursor', 'skills')],
    [
      'OpenCode',
      path.join(
        env.XDG_CONFIG_HOME || path.join(home, '.config'),
        'opencode',
        'skills',
      ),
    ],
    ['Windsurf', path.join(home, '.codeium', 'windsurf', 'skills')],
  ])
    add(client, directory, 'user', 2)
  // Plugin caches have a fixed layout: marketplace / plugin / version / skills / name.
  add('Claude Code', path.join(claudeHome, 'plugins', 'cache'), 'user', 5)
  add('Codex', path.join(codexHome, 'plugins', 'cache'), 'user', 5)
  for (const directory of [project, ...(options.extraDirectories ?? [])].filter(
    (v): v is string => Boolean(v),
  )) {
    for (const [client, folder] of [
      ['Claude Code', '.claude'],
      ['Codex', '.codex'],
      ['Agents', '.agents'],
      ['Cursor', '.cursor'],
      ['OpenCode', '.opencode'],
    ]) {
      add(
        client,
        path.join(directory, folder, 'skills'),
        directory === project ? 'project' : 'user',
        2,
      )
    }
    if (directory !== project) add('Custom', directory, 'user', 2)
  }
  for (const config of [
    path.join(codexHome, 'config.toml'),
    ...(project ? [path.join(project, '.codex', 'config.toml')] : []),
  ]) {
    try {
      const stat = fs.statSync(config)
      if (stat.size > 1024 * 1024) continue
      const parsed = parseToml(fs.readFileSync(config, 'utf8'))
      const skills = parsed.skills as
        | { config?: Array<{ path?: string }> }
        | undefined
      for (const entry of skills?.config ?? []) {
        if (typeof entry.path !== 'string') continue
        const expanded = entry.path.startsWith('~/')
          ? path.join(home, entry.path.slice(2))
          : path.resolve(path.dirname(config), entry.path)
        add(
          'Codex',
          expanded.endsWith('SKILL.md') ? path.dirname(expanded) : expanded,
          config.startsWith(codexHome + path.sep) ? 'user' : 'project',
          0,
        )
      }
    } catch {
      /* Config parse errors are already reported by MCP discovery. */
    }
  }
  const seenRoots = new Set<string>()
  for (const root of roots) {
    if (seenRoots.has(root.directory)) continue
    seenRoots.add(root.directory)
    const location: DiscoveryLocation = {
      client: root.client,
      path: shortPath(root.directory, home, project),
      scope: root.scope,
      kind: 'skill',
      status: 'missing',
      count: 0,
    }
    locations.push(location)
    const visited = new Set<string>()
    let remaining = 4000
    const walk = (directory: string, depth: number) => {
      if (--remaining < 0)
        throw new Error(
          'Directory limit reached (4000). Choose a more specific directory.',
        )
      const real = fs.realpathSync(directory)
      if (visited.has(real)) return
      visited.add(real)
      const skillFile = path.join(real, 'SKILL.md')
      if (fs.existsSync(skillFile)) {
        try {
          if (fs.statSync(skillFile).size > 1024 * 1024)
            throw new Error('SKILL.md exceeds 1 MB')
          const parsed = parseSkillFile(skillFile)
          const id = createHash('sha256')
            .update(real)
            .digest('hex')
            .slice(0, 24)
          const source = {
            client: root.client,
            path: shortPath(path.join(directory, 'SKILL.md'), home, project),
            scope: root.scope,
          }
          const existing = found.get(id)
          if (existing) {
            if (
              !existing.sources.some(
                (s) => s.path === source.path && s.client === source.client,
              )
            )
              existing.sources.push(source)
          } else {
            const target = project
              ? path.join(
                  project,
                  '.synax',
                  'skills',
                  safeSkillName(parsed.name),
                  'SKILL.md',
                )
              : ''
            const occupied = Boolean(target && fs.existsSync(target))
            const installed =
              occupied &&
              fs.statSync(target).size <= 1024 * 1024 &&
              fs.readFileSync(target, 'utf8') ===
                fs.readFileSync(skillFile, 'utf8')
            found.set(id, {
              id,
              name: parsed.name,
              description: parsed.description,
              content: parsed.content.slice(0, 12000),
              installed,
              conflict: occupied && !installed,
              sources: [source],
            })
            paths.set(id, real)
          }
          location.count++
        } catch (error) {
          location.status = 'error'
          location.message =
            error instanceof Error ? error.message : String(error)
        }
        return
      }
      if (!depth) return
      for (const entry of fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (
          ['node_modules', '.git', 'assets', 'references', 'scripts'].includes(
            entry.name,
          )
        )
          continue
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          try {
            if (fs.statSync(path.join(directory, entry.name)).isDirectory())
              walk(path.join(directory, entry.name), depth - 1)
          } catch (error) {
            location.status = 'error'
            location.message =
              error instanceof Error ? error.message : String(error)
          }
        }
      }
    }
    try {
      if (!fs.existsSync(root.directory)) continue
      location.status = 'found'
      walk(root.directory, root.depth)
    } catch (error) {
      location.status = 'error'
      location.message = error instanceof Error ? error.message : String(error)
    }
  }
  return {
    mcp,
    skills: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
    locations,
    paths,
  }
}

function safeSkillName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name))
    throw new Error(`Unsupported skill directory name: ${name}`)
  return name
}

/** Copy the complete package, preserving scripts and references; never overwrite a local skill. */
export function importDiscoveredSkill(
  project: string,
  id: string,
  options: LocalDiscoveryOptions = {},
) {
  const result = discoverLocalIntegrations(project, options)
  const skill = result.skills.find((item) => item.id === id)
  const source = result.paths.get(id)
  if (!skill || !source)
    throw new Error('Skill is no longer available. Scan again.')
  const root = path.join(project, '.synax', 'skills')
  const target = path.join(root, safeSkillName(skill.name))
  if (fs.existsSync(target))
    throw new Error('A skill with this name already exists in this project.')
  let bytes = 0
  let files = 0
  const visited = new Set<string>()
  function validate(directory: string) {
    const real = fs.realpathSync(directory)
    if (real !== source && !real.startsWith(source + path.sep))
      throw new Error('Skill contains a link outside its package.')
    if (visited.has(real))
      throw new Error('Skill contains a circular or repeated directory link.')
    visited.add(real)
    for (const entry of fs.readdirSync(directory)) {
      if (++files > 4000) throw new Error('Skill exceeds 4000 files.')
      const file = path.join(directory, entry)
      const resolved = fs.realpathSync(file)
      if (!resolved.startsWith(source + path.sep))
        throw new Error('Skill contains a link outside its package.')
      const stat = fs.statSync(file)
      if (stat.isDirectory()) validate(file)
      else if (!stat.isFile())
        throw new Error('Skill contains an unsupported file type.')
      else if ((bytes += stat.size) > 32 * 1024 * 1024)
        throw new Error('Skill exceeds 32 MB.')
    }
  }
  validate(source)
  fs.mkdirSync(root, { recursive: true })
  const staging = fs.mkdtempSync(path.join(root, '.import-'))
  try {
    fs.cpSync(source, staging, { recursive: true, dereference: true })
    // mkdir reserves the name so concurrent imports cannot overwrite one another.
    fs.mkdirSync(target)
    try {
      for (const file of fs.readdirSync(staging))
        fs.renameSync(path.join(staging, file), path.join(target, file))
    } catch (error) {
      fs.rmSync(target, { recursive: true, force: true })
      throw error
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  return { id: `project/${skill.name}`, name: skill.name }
}
