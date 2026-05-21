import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { AgentRunChangeSummary, AgentRunFileChange } from './contracts.js'

const execFileAsync = promisify(execFile)

export interface SourceLinkHint {
  path?: string
  startLine?: number
  endLine?: number
}

export interface CapturedFileChanges {
  fileChanges: AgentRunFileChange[]
  changeSummary: AgentRunChangeSummary
}

export interface FileChangeBaseline {
  workDir: string
  dirtyFiles: Record<string, { exists: boolean; content?: string }>
}

export async function captureFileChangeBaseline(workDir?: string | null): Promise<FileChangeBaseline | null> {
  if (!workDir || !workDir.trim()) return null
  const cwd = resolve(workDir)
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree'])
    const status = await git(cwd, ['status', '--porcelain'])
    const paths = [...parseGitStatus(status.stdout).keys()]
    const dirtyFiles: FileChangeBaseline['dirtyFiles'] = {}
    for (const path of paths) {
      dirtyFiles[path] = await readSnapshotFile(cwd, path)
    }
    return { workDir: cwd, dirtyFiles }
  } catch {
    return null
  }
}

export async function captureFileChanges(
  workDir?: string | null,
  hints: SourceLinkHint[] = [],
  baseline?: FileChangeBaseline | null,
): Promise<CapturedFileChanges> {
  const hintChanges = changesFromHints(hints)
  if (!workDir || !workDir.trim()) return summarizeChanges(hintChanges)
  try {
    const gitChanges = baseline
      ? await captureGitChangesSinceBaseline(workDir, baseline)
      : await captureGitChanges(workDir)
    const merged = mergeChanges(gitChanges, hintChanges)
    return summarizeChanges(merged)
  } catch {
    return summarizeChanges(hintChanges)
  }
}

export function changesFromHints(hints: SourceLinkHint[]): AgentRunFileChange[] {
  const byPath = new Map<string, AgentRunFileChange>()
  for (const hint of hints) {
    if (!hint.path) continue
    const path = normalizePath(hint.path)
    if (!path) continue
    const prev = byPath.get(path)
    byPath.set(path, {
      path,
      changeType: 'unknown',
      source: 'acp_hint',
      startLine: prev?.startLine ?? hint.startLine,
      endLine: prev?.endLine ?? hint.endLine,
    })
  }
  return [...byPath.values()]
}

async function captureGitChanges(workDir: string): Promise<AgentRunFileChange[]> {
  const cwd = resolve(workDir)
  const [status, numstat] = await Promise.all([
    git(cwd, ['status', '--porcelain']),
    git(cwd, ['diff', '--numstat', 'HEAD', '--']),
  ])
  const statusChanges = parseGitStatus(status.stdout)
  const stats = parseNumstat(numstat.stdout)
  const out = new Map<string, AgentRunFileChange>()

  for (const [path, changeType] of statusChanges) {
    const stat = stats.get(path)
    out.set(path, {
      path,
      changeType,
      additions: stat?.additions,
      deletions: stat?.deletions,
      source: 'git',
    })
  }

  for (const [path, stat] of stats) {
    if (out.has(path)) continue
    out.set(path, {
      path,
      changeType: 'modified',
      additions: stat.additions,
      deletions: stat.deletions,
      source: 'git',
    })
  }

  for (const change of out.values()) {
    if (change.changeType === 'added' && change.additions === undefined) {
      change.additions = await countFileLines(cwd, change.path)
      change.deletions = change.deletions ?? 0
    }
  }

  return [...out.values()]
}

async function captureGitChangesSinceBaseline(
  workDir: string,
  baseline: FileChangeBaseline,
): Promise<AgentRunFileChange[]> {
  const cwd = resolve(workDir)
  const status = await git(cwd, ['status', '--porcelain'])
  const finalStatus = parseGitStatus(status.stdout)
  const finalPaths = new Set([...finalStatus.keys(), ...Object.keys(baseline.dirtyFiles)])
  const out: AgentRunFileChange[] = []

  for (const path of finalPaths) {
    const before = baseline.dirtyFiles[path] ?? await readHeadSnapshot(cwd, path)
    const after = await readSnapshotFile(cwd, path)
    if (before.exists === after.exists && before.content === after.content) continue

    const stats = diffLineStats(before.exists ? before.content ?? '' : '', after.exists ? after.content ?? '' : '')
    out.push({
      path,
      changeType: inferChangeType(before.exists, after.exists, finalStatus.get(path)),
      additions: stats.additions,
      deletions: stats.deletions,
      source: 'git',
    })
  }

  return out
}

async function readSnapshotFile(cwd: string, relativePath: string): Promise<{ exists: boolean; content?: string }> {
  const full = resolve(cwd, relativePath)
  if (!isInside(cwd, full)) return { exists: false }
  try {
    return { exists: true, content: await readFile(full, 'utf-8') }
  } catch {
    return { exists: false }
  }
}

async function readHeadSnapshot(cwd: string, relativePath: string): Promise<{ exists: boolean; content?: string }> {
  try {
    const { stdout } = await git(cwd, ['show', `HEAD:${relativePath.replace(/\\/g, '/')}`])
    return { exists: true, content: stdout }
  } catch {
    return { exists: false }
  }
}

function inferChangeType(
  existedBefore: boolean,
  existsAfter: boolean,
  finalStatus?: AgentRunFileChange['changeType'],
): AgentRunFileChange['changeType'] {
  if (!existedBefore && existsAfter) return 'added'
  if (existedBefore && !existsAfter) return 'deleted'
  if (finalStatus === 'renamed') return 'renamed'
  if (existedBefore && existsAfter) return 'modified'
  return finalStatus ?? 'unknown'
}

export function diffLineStats(before: string, after: string): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 }
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length * b.length <= 250_000) {
    const common = lcsLength(a, b)
    return {
      additions: Math.max(0, b.length - common),
      deletions: Math.max(0, a.length - common),
    }
  }
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let aEnd = a.length - 1
  let bEnd = b.length - 1
  while (aEnd >= start && bEnd >= start && a[aEnd] === b[bEnd]) {
    aEnd -= 1
    bEnd -= 1
  }
  return {
    additions: Math.max(0, bEnd - start + 1),
    deletions: Math.max(0, aEnd - start + 1),
  }
}

function lcsLength(a: string[], b: string[]): number {
  const prev = new Array<number>(b.length + 1).fill(0)
  const curr = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1])
    }
    for (let j = 0; j <= b.length; j += 1) {
      prev[j] = curr[j]
      curr[j] = 0
    }
  }
  return prev[b.length]
}

function splitLines(text: string): string[] {
  if (!text) return []
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

async function git(cwd: string, args: string[]) {
  return execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 })
}

export function parseGitStatus(stdout: string): Map<string, AgentRunFileChange['changeType']> {
  const out = new Map<string, AgentRunFileChange['changeType']>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const code = line.slice(0, 2)
    const rawPath = line.slice(3).trim()
    if (!rawPath) continue
    const renamed = rawPath.includes(' -> ')
    const path = normalizePath(renamed ? rawPath.split(' -> ').pop() ?? rawPath : rawPath)
    if (!path) continue
    if (code.includes('D')) out.set(path, 'deleted')
    else if (code.includes('A') || code === '??') out.set(path, 'added')
    else if (code.includes('R') || renamed) out.set(path, 'renamed')
    else if (code.includes('M')) out.set(path, 'modified')
    else out.set(path, 'unknown')
  }
  return out
}

export function parseNumstat(stdout: string): Map<string, { additions: number; deletions: number }> {
  const out = new Map<string, { additions: number; deletions: number }>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = parseStatInt(parts[0])
    const deletions = parseStatInt(parts[1])
    const path = normalizePath(parseNumstatPath(parts.slice(2).join('\t')))
    if (!path) continue
    out.set(path, { additions, deletions })
  }
  return out
}

function parseNumstatPath(raw: string): string {
  const trimmed = raw.trim()
  const arrow = trimmed.match(/^(?:\{.* => .*\}|.*) => (.*)$/)
  if (arrow?.[1]) return arrow[1].replace(/[{}]/g, '')
  return trimmed
}

function parseStatInt(raw: string): number {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : 0
}

async function countFileLines(cwd: string, relativePath: string): Promise<number> {
  const full = resolve(cwd, relativePath)
  if (!isInside(cwd, full)) return 0
  try {
    const text = await readFile(full, 'utf-8')
    if (!text) return 0
    return text.split(/\r?\n/).length
  } catch {
    return 0
  }
}

function mergeChanges(gitChanges: AgentRunFileChange[], hintChanges: AgentRunFileChange[]): AgentRunFileChange[] {
  const byPath = new Map<string, AgentRunFileChange>()
  for (const change of hintChanges) byPath.set(change.path, change)
  for (const change of gitChanges) byPath.set(change.path, change)
  return [...byPath.values()]
}

export function summarizeChanges(fileChanges: AgentRunFileChange[]): CapturedFileChanges {
  const summary: AgentRunChangeSummary = {
    added: 0,
    modified: 0,
    deleted: 0,
    files: fileChanges.length,
    insertions: 0,
    deletions: 0,
  }
  for (const change of fileChanges) {
    if (change.changeType === 'added') summary.added += 1
    else if (change.changeType === 'deleted') summary.deleted += 1
    else if (change.changeType === 'modified' || change.changeType === 'renamed') summary.modified += 1
    summary.insertions += change.additions ?? 0
    summary.deletions += change.deletions ?? 0
  }
  return { fileChanges, changeSummary: summary }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').trim()
}

function isInside(root: string, target: string): boolean {
  const rel = normalize(resolve(root))
  const child = normalize(target)
  return child === rel || child.startsWith(rel + sep)
}
