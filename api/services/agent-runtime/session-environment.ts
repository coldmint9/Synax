import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { agentRuntimeStore } from './session-store.js'
import { resolveSessionWorkDir } from './tools/workspace.js'
import { AgentNotFoundError, AgentValidationError } from './runtime-errors.js'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 8 * 1024 * 1024
const MAX_FILE_BYTES = 1024 * 1024

export type EnvironmentChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'unknown'

export interface SessionEnvironmentFile {
  path: string
  status: EnvironmentChangeStatus
  additions: number
  deletions: number
  staged: boolean
  untracked: boolean
}

export interface SessionEnvironmentSubagent {
  id: string
  parentSessionId: string | null
  profileId: string
  status: string
  title: string | null
  prompt: string
  updatedAt: string
  completedAt: string | null
  resultSummary: string | null
}

export interface SessionEnvironment {
  sessionId: string
  projectId: string
  workspacePath: string
  branch: string
  headCommitSha: string
  dirty: boolean
  additions: number
  deletions: number
  changedFiles: SessionEnvironmentFile[]
  inputFiles: string[]
  subagents: SessionEnvironmentSubagent[]
  refreshedAt: string
}

export interface SessionEnvironmentFileView {
  sessionId: string
  path: string
  kind: 'diff' | 'input'
  content: string
  truncated: boolean
}

async function git(workspacePath: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd: workspacePath,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    })
    return String(result.stdout ?? '')
  } catch (error) {
    const output = error as { stdout?: string }
    return String(output.stdout ?? '')
  }
}

function assertRelativePath(relativePath: string): string {
  const clean = relativePath.replace(/\\/g, '/').trim()
  if (!clean || clean === '.' || clean.startsWith('/') || clean.includes('\0')) {
    throw new AgentValidationError('File path must be a workspace-relative path.')
  }
  const parts = clean.split('/')
  if (parts.includes('..') || parts.includes('.git')) {
    throw new AgentValidationError('File path is outside the visible workspace.')
  }
  return clean
}

function resolveSafeFile(workspacePath: string, relativePath: string): string {
  const clean = assertRelativePath(relativePath)
  const root = path.resolve(workspacePath)
  const absolute = path.resolve(root, clean)
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new AgentValidationError('File path is outside the workspace.')
  }
  return absolute
}

function parseStatusLine(line: string): { xy: string; path: string; originalPath?: string } | null {
  if (line.length < 4) return null
  const xy = line.slice(0, 2)
  const raw = line.slice(3)
  if (xy.includes('R') && raw.includes(' -> ')) {
    const [originalPath, nextPath] = raw.split(' -> ')
    return { xy, path: nextPath, originalPath }
  }
  return { xy, path: raw }
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>()
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = Number(parts[0])
    const deletions = Number(parts[1])
    const filePath = parts.slice(2).join('\t')
    result.set(filePath, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    })
  }
  return result
}

function readInputFiles(sessionId: string): string[] {
  const paths = new Set<string>()
  for (const call of agentRuntimeStore.listToolCalls(sessionId)) {
    if (call.toolId !== 'file.read') continue
    const input = call.inputRef
    if (!input || typeof input !== 'object') continue
    const candidate = (input as { path?: unknown }).path
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    try {
      paths.add(assertRelativePath(candidate))
    } catch {
      // Ignore malformed/blocked historical paths.
    }
  }
  return [...paths]
}

function getSession(sessionId: string) {
  try {
    return agentRuntimeStore.getSession(sessionId)
  } catch {
    throw new AgentNotFoundError(sessionId)
  }
}

/**
 * Cache + single-flight for the workspace/profile snapshot.
 *
 * The panel polls this endpoint while a run is in flight, and every call used
 * to spawn four git processes (status/diff/rev-parse/branch). Coalescing the
 * polls keeps that side-channel work from competing with the run itself.
 */
const ENVIRONMENT_CACHE_TTL_MS = 5_000
const environmentCache = new Map<string, { at: number; value: SessionEnvironment }>()
const environmentInFlight = new Map<string, Promise<SessionEnvironment>>()

export async function getSessionEnvironment(sessionId: string): Promise<SessionEnvironment> {
  const cached = environmentCache.get(sessionId)
  if (cached && Date.now() - cached.at < ENVIRONMENT_CACHE_TTL_MS) {
    return cached.value
  }
  const pending = environmentInFlight.get(sessionId)
  if (pending) return pending

  const task = computeSessionEnvironment(sessionId)
  environmentInFlight.set(sessionId, task)
  try {
    const value = await task
    environmentCache.set(sessionId, { at: Date.now(), value })
    return value
  } finally {
    environmentInFlight.delete(sessionId)
  }
}

export function invalidateSessionEnvironment(sessionId: string): void {
  environmentCache.delete(sessionId)
  environmentInFlight.delete(sessionId)
}

async function computeSessionEnvironment(sessionId: string): Promise<SessionEnvironment> {
  const session = getSession(sessionId)
  const workspacePath = resolveSessionWorkDir(sessionId, session.projectId)
  const [branchRaw, headCommitShaRaw, statusRaw, numstatRaw] = await Promise.all([
    git(workspacePath, ['branch', '--show-current']),
    git(workspacePath, ['rev-parse', 'HEAD']),
    git(workspacePath, ['status', '--porcelain=v1', '-uall']),
    git(workspacePath, ['diff', 'HEAD', '--numstat']),
  ])

  const numstat = parseNumstat(numstatRaw)
  const changedFiles: SessionEnvironmentFile[] = []
  for (const line of statusRaw.split('\n')) {
    const parsed = parseStatusLine(line)
    if (!parsed) continue
    const status = parsed.xy.includes('R')
      ? 'renamed'
      : parsed.xy === '??'
        ? 'untracked'
        : parsed.xy.includes('A')
          ? 'added'
          : parsed.xy.includes('D')
            ? 'deleted'
            : parsed.xy.includes('M')
              ? 'modified'
              : 'unknown'
    const stats = numstat.get(parsed.path) ?? { additions: 0, deletions: 0 }
    changedFiles.push({
      path: parsed.path,
      status,
      additions: stats.additions,
      deletions: stats.deletions,
      staged: parsed.xy[0] !== ' ' && parsed.xy !== '??',
      untracked: parsed.xy === '??',
    })
  }

  const subagents: SessionEnvironmentSubagent[] = []
  for (const childId of session.childSessionIds ?? []) {
    try {
      const child = agentRuntimeStore.getSession(childId)
      subagents.push({
        id: child.id,
        parentSessionId: child.parentSessionId,
        profileId: child.profileId,
        status: child.status,
        title: child.title,
        prompt: child.prompt,
        updatedAt: child.updatedAt,
        completedAt: child.completedAt,
        resultSummary: child.resultSummary,
      })
    } catch {
      // child may have been deleted; skip
    }
  }

  return {
    sessionId,
    projectId: session.projectId,
    workspacePath,
    branch: branchRaw.trim() || 'unknown',
    headCommitSha: headCommitShaRaw.trim() || '',
    dirty: changedFiles.length > 0,
    additions: changedFiles.reduce((sum, file) => sum + file.additions, 0),
    deletions: changedFiles.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles,
    inputFiles: readInputFiles(sessionId),
    subagents,
    refreshedAt: new Date().toISOString(),
  }
}

export async function getSessionEnvironmentFile(
  sessionId: string,
  relativePath: string,
  kind: 'diff' | 'input',
): Promise<SessionEnvironmentFileView> {
  const session = getSession(sessionId)
  const workspacePath = resolveSessionWorkDir(sessionId, session.projectId)
  const cleanPath = assertRelativePath(relativePath)
  const absolutePath = resolveSafeFile(workspacePath, cleanPath)
  let content = ''

  if (kind === 'diff') {
    const trackedDiff = await git(workspacePath, ['diff', 'HEAD', '--', cleanPath])
    if (trackedDiff.trim()) {
      content = trackedDiff
    } else if (fs.existsSync(absolutePath)) {
      // `git diff HEAD` does not include untracked files; render them as a new-file diff.
      content = await git(workspacePath, ['diff', '--no-index', '--', '/dev/null', absolutePath])
    }
  } else {
    if (!fs.existsSync(absolutePath)) {
      throw new AgentValidationError(`File not found: ${cleanPath}`)
    }
    const stat = fs.statSync(absolutePath)
    if (!stat.isFile()) throw new AgentValidationError(`Not a file: ${cleanPath}`)
    content = fs.readFileSync(absolutePath).subarray(0, MAX_FILE_BYTES).toString('utf8')
  }

  return {
    sessionId,
    path: cleanPath,
    kind,
    content,
    truncated: kind === 'input' && Buffer.byteLength(content, 'utf8') >= MAX_FILE_BYTES,
  }
}
