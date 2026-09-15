import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listToolCalls: vi.fn(),
  resolveSessionWorkDir: vi.fn(),
}))

vi.mock('../session-store.js', () => ({ agentRuntimeStore: mocks }))
vi.mock('../tools/workspace.js', () => ({ resolveSessionWorkDir: mocks.resolveSessionWorkDir }))

import { getSessionEnvironment, invalidateSessionEnvironment } from '../session-environment.js'

const sessionId = 'gitignore-environment-test'
let workspace: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' })
}

function write(file: string, content: string): void {
  const target = path.join(workspace, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-environment-'))
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  write('.gitignore', 'generated/*\n!generated/keep.ts\n*.log\n')
  write('src/main.ts', 'before\n')
  write('generated/keep.ts', 'before\n')
  write('generated/build.js', 'before\n')
  write('generated/deleted.js', 'before\n')
  write('generated/缓存.js', 'before\n')
  write('generated/with space.js', 'before\n')
  write('generated/with\nnewline.js', 'before\n')
  git('add', '--force', '.')
  git('commit', '--quiet', '-m', 'fixture')
  mocks.getSession.mockReturnValue({ id: sessionId, projectId: 'project', childSessionIds: [] })
  mocks.resolveSessionWorkDir.mockReturnValue(workspace)
  mocks.listToolCalls.mockReturnValue([])
  invalidateSessionEnvironment(sessionId)
})

afterEach(() => {
  invalidateSessionEnvironment(sessionId)
  fs.rmSync(workspace, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('session environment Git ignore filtering', () => {
  it('excludes ignored tracked and untracked changes from files, line totals and agent attribution', async () => {
    write('src/main.ts', 'after\nextra\n')
    write('src/new.ts', 'new\n')
    write('generated/keep.ts', 'after\n')
    write('generated/build.js', 'after\nignored\n')
    write('generated/缓存.js', 'after\n')
    write('generated/with space.js', 'after\n')
    write('generated/with\nnewline.js', 'after\n')
    write('generated/new.js', 'ignored\n')
    write('debug.log', 'ignored\n')
    write('generated/staged.js', 'ignored\n')
    git('add', '--force', 'generated/staged.js')
    git('rm', '--quiet', 'generated/deleted.js')
    mocks.listToolCalls.mockReturnValue([
      { toolId: 'edit', inputRef: { path: 'src/main.ts' } },
      { toolId: 'edit', inputRef: { path: 'generated/build.js' } },
    ])

    const environment = await getSessionEnvironment(sessionId)

    expect(environment.changedFiles.map(file => file.path).sort()).toEqual([
      'generated/keep.ts', 'src/main.ts', 'src/new.ts',
    ])
    expect(environment.additions).toBe(4)
    expect(environment.deletions).toBe(2)
    expect(environment.dirty).toBe(true)
    expect(environment.agentChangedFiles.map(file => file.path)).toEqual(['src/main.ts'])
  })

  it('reports no changes when only ignored files changed, including nested ignore rules', async () => {
    write('generated/build.js', 'ignored change\n')
    write('debug.log', 'ignored\n')
    write('src/.gitignore', 'cache/\n!keep.log\n')
    git('add', 'src/.gitignore')
    git('commit', '--quiet', '-m', 'nested rules')
    write('src/cache/tracked.ts', 'before\n')
    git('add', '--force', 'src/cache/tracked.ts')
    git('commit', '--quiet', '-m', 'tracked cache')
    write('src/cache/tracked.ts', 'after\n')

    const environment = await getSessionEnvironment(sessionId)

    expect(environment.changedFiles).toEqual([])
    expect(environment.agentChangedFiles).toEqual([])
    expect(environment.additions).toBe(0)
    expect(environment.deletions).toBe(0)
    expect(environment.dirty).toBe(false)
  })

  it('preserves ordinary changes when no paths match ignore rules', async () => {
    write('src/main.ts', 'after\n')
    git('add', 'src/main.ts')
    const environment = await getSessionEnvironment(sessionId)
    expect(environment.changedFiles).toEqual([
      { path: 'src/main.ts', status: 'modified', additions: 1, deletions: 1, staged: true, untracked: false },
    ])
  })

  it('filters renamed files by destination while retaining visible rename paths and line counts', async () => {
    write('src/main.ts', 'one\ntwo\nthree\nfour\nfive\n')
    git('add', 'src/main.ts')
    git('commit', '--quiet', '-m', 'rename fixture')
    git('mv', 'src/main.ts', 'src/renamed 文件.ts')
    write('src/renamed 文件.ts', 'one\ntwo\nthree\nfour\nfive\nsix\n')
    git('mv', 'generated/keep.ts', 'generated/ignored.ts')

    const environment = await getSessionEnvironment(sessionId)

    expect(environment.changedFiles).toEqual([
      { path: 'src/renamed 文件.ts', status: 'renamed', additions: 1, deletions: 0, staged: true, untracked: false },
    ])
    expect(environment.additions).toBe(1)
    expect(environment.deletions).toBe(0)
  })
})
