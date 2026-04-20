/**
 * Synapse Memory Store
 *
 * File-based persistent memory with user-level and project-level scopes.
 * Directly inspired by clawspring's memory/store.py with YAML frontmatter,
 * but implemented in TypeScript with structured type safety.
 *
 * Storage layout:
 *   user scope    : ~/.synapse/memory/<slug>.md
 *   project scope : .synapse/memory/<slug>.md  (relative to project root)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

// ─── Data Model ───────────────────────────────────────────────────────────

export interface MemoryEntry {
  name: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  content: string
  filePath?: string
  created: string
  scope: 'user' | 'project'
  confidence: number
  source: 'user' | 'model' | 'tool' | 'consolidator'
  lastUsedAt: string
  conflictGroup: string
}

// ─── Paths ────────────────────────────────────────────────────────────────

const USER_MEMORY_DIR = join(homedir(), '.synapse', 'memory')
const INDEX_FILENAME = 'MEMORY.md'
const MAX_INDEX_LINES = 200
const MAX_INDEX_BYTES = 25_000

export function getProjectMemoryDir(projectRoot?: string): string {
  return join(projectRoot ?? process.cwd(), '.synapse', 'memory')
}

export function getMemoryDir(scope: 'user' | 'project', projectRoot?: string): string {
  return scope === 'project' ? getProjectMemoryDir(projectRoot) : USER_MEMORY_DIR
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 60)
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const end = text.indexOf('---', 3)
  if (end === -1) return { meta: {}, body: text }

  const fmText = text.slice(3, end).trim()
  const body = text.slice(end + 3).trim()
  const meta: Record<string, string> = {}

  for (const line of fmText.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx !== -1) {
      meta[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
    }
  }

  return { meta, body }
}

function formatEntryMd(entry: MemoryEntry): string {
  const lines = [
    '---',
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `type: ${entry.type}`,
    `created: ${entry.created}`,
  ]
  if (entry.confidence !== 1.0) lines.push(`confidence: ${entry.confidence.toFixed(2)}`)
  if (entry.source && entry.source !== 'user') lines.push(`source: ${entry.source}`)
  if (entry.lastUsedAt) lines.push(`last_used_at: ${entry.lastUsedAt}`)
  if (entry.conflictGroup) lines.push(`conflict_group: ${entry.conflictGroup}`)
  lines.push('---')
  lines.push(entry.content)
  return lines.join('\n') + '\n'
}

// ─── Core Operations ──────────────────────────────────────────────────────

export function saveMemory(entry: MemoryEntry, scope: 'user' | 'project' = 'user', projectRoot?: string): void {
  const memDir = getMemoryDir(scope, projectRoot)
  mkdirSync(memDir, { recursive: true })
  const slug = slugify(entry.name)
  const fp = join(memDir, `${slug}.md`)
  writeFileSync(fp, formatEntryMd(entry), 'utf-8')
  entry.filePath = fp
  entry.scope = scope
  rewriteIndex(scope, projectRoot)
}

export function deleteMemory(name: string, scope: 'user' | 'project' = 'user', projectRoot?: string): void {
  const memDir = getMemoryDir(scope, projectRoot)
  const slug = slugify(name)
  const fp = join(memDir, `${slug}.md`)
  if (existsSync(fp)) unlinkSync(fp)
  rewriteIndex(scope, projectRoot)
}

export function loadEntries(scope: 'user' | 'project' = 'user', projectRoot?: string): MemoryEntry[] {
  const memDir = getMemoryDir(scope, projectRoot)
  if (!existsSync(memDir)) return []

  const entries: MemoryEntry[] = []
  const files = readdirSync(memDir).filter(f => f.endsWith('.md') && f !== INDEX_FILENAME).sort()

  for (const file of files) {
    try {
      const text = readFileSync(join(memDir, file), 'utf-8')
      const { meta, body } = parseFrontmatter(text)
      entries.push({
        name: meta.name ?? file.replace('.md', ''),
        description: meta.description ?? '',
        type: (meta.type as MemoryEntry['type']) ?? 'user',
        content: body,
        filePath: join(memDir, file),
        created: meta.created ?? '',
        scope,
        confidence: parseFloat(meta.confidence ?? '1.0'),
        source: (meta.source as MemoryEntry['source']) ?? 'user',
        lastUsedAt: meta.last_used_at ?? '',
        conflictGroup: meta.conflict_group ?? '',
      })
    } catch {
      // Skip unreadable files
    }
  }

  return entries
}

export function loadIndex(scope: 'user' | 'project' | 'all' = 'all', projectRoot?: string): MemoryEntry[] {
  if (scope === 'all') return [...loadEntries('user', projectRoot), ...loadEntries('project', projectRoot)]
  return loadEntries(scope, projectRoot)
}

export function searchMemory(query: string, scope: 'user' | 'project' | 'all' = 'all', projectRoot?: string): MemoryEntry[] {
  const q = query.toLowerCase()
  return loadIndex(scope, projectRoot).filter(entry => {
    const haystack = `${entry.name} ${entry.description} ${entry.content}`.toLowerCase()
    return haystack.includes(q)
  })
}

// ─── Index Management ─────────────────────────────────────────────────────

function rewriteIndex(scope: 'user' | 'project', projectRoot?: string): void {
  const memDir = getMemoryDir(scope, projectRoot)
  if (!existsSync(memDir)) return
  const indexPath = join(memDir, INDEX_FILENAME)
  const entries = loadEntries(scope, projectRoot)
  const lines = entries.map(e => `- [${e.name}](${e.filePath?.split('/').pop() ?? e.name}) — ${e.description}`)
  writeFileSync(indexPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8')
}

export function getIndexContent(scope: 'user' | 'project' = 'user', projectRoot?: string): string {
  const memDir = getMemoryDir(scope, projectRoot)
  const indexPath = join(memDir, INDEX_FILENAME)
  if (!existsSync(indexPath)) return ''
  return readFileSync(indexPath, 'utf-8').trim()
}

// ─── Conflict Detection ───────────────────────────────────────────────────

export function checkConflict(entry: MemoryEntry, scope: 'user' | 'project' = 'user', projectRoot?: string): Record<string, unknown> | null {
  const memDir = getMemoryDir(scope, projectRoot)
  const slug = slugify(entry.name)
  const fp = join(memDir, `${slug}.md`)
  if (!existsSync(fp)) return null

  try {
    const { meta, body } = parseFrontmatter(readFileSync(fp, 'utf-8'))
    if (body.trim() === entry.content.trim()) return null
    return {
      existingContent: body.trim(),
      existingConfidence: parseFloat(meta.confidence ?? '1.0'),
      existingCreated: meta.created ?? '',
      existingSource: meta.source ?? 'user',
    }
  } catch {
    return null
  }
}

// ─── Memory Context for System Prompt ─────────────────────────────────────

export function getMemoryContext(projectRoot?: string): string {
  const userIndex = getIndexContent('user')
  const projectIndex = getIndexContent('project', projectRoot)
  const parts: string[] = []
  if (userIndex) parts.push(`[User Memory]\n${userIndex}`)
  if (projectIndex) parts.push(`[Project Memory]\n${projectIndex}`)
  return parts.join('\n\n')
}
