import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectWorkspaceRoot } from '../../project-workspace.js'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listToolCalls: vi.fn(),
  resolveSessionWorkspaceRoots: vi.fn(),
  generateGatewayTextResult: vi.fn(),
  startAuxUsage: vi.fn(),
  finishAuxUsage: vi.fn(),
}))

vi.mock('../session-store.js', () => ({
  agentRuntimeStore: { getSession: mocks.getSession, listToolCalls: mocks.listToolCalls },
}))
vi.mock('../tools/workspace.js', () => ({ resolveSessionWorkspaceRoots: mocks.resolveSessionWorkspaceRoots }))
vi.mock('../../llm-runtime/gateway.js', () => ({ generateGatewayTextResult: mocks.generateGatewayTextResult }))
vi.mock('../usage-projection.js', () => ({ startAuxUsage: mocks.startAuxUsage, finishAuxUsage: mocks.finishAuxUsage }))
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

import {
  getSessionEnvironment,
  getSessionEnvironmentFile,
  saveSessionEnvironmentFile,
  invalidateSessionEnvironment,
} from '../session-environment.js'
import { commitSessionWorkspace } from '../session-git-commit.js'

const sessionId = 'multi-root-workspace-git-test'
const relativePath = 'src/shared.txt'
let fixtureDirectory = ''
let primary: ProjectWorkspaceRoot
let reference: ProjectWorkspaceRoot

function git(root: ProjectWorkspaceRoot, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root.path, encoding: 'utf8', timeout: 10_000 })
}

function writeSharedFile(root: ProjectWorkspaceRoot, content: string): void {
  const target = path.join(root.path, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function createRepository(id: string, role: ProjectWorkspaceRoot['role']): ProjectWorkspaceRoot {
  const root: ProjectWorkspaceRoot = {
    id, name: `${id} project`, path: path.join(fixtureDirectory, id), role, status: 'available',
  }
  fs.mkdirSync(root.path)
  git(root, 'init', '--quiet', '--initial-branch=main', '--template=')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.autocrlf', 'false')
  git(root, 'config', 'core.excludesFile', path.join(fixtureDirectory, 'gitignore'))
  writeSharedFile(root, `${id} before\n`)
  git(root, 'add', '--', relativePath)
  git(root, 'commit', '--quiet', '-m', 'fixture')

  // Distinct staged and working contents expose accidental staging in another root.
  writeSharedFile(root, `${id} staged\n`)
  git(root, 'add', '--', relativePath)
  writeSharedFile(root, `${id} working\n`)
  return root
}

function repositoryState(root: ProjectWorkspaceRoot) {
  return {
    head: git(root, 'rev-parse', 'HEAD').trim(),
    index: fs.readFileSync(path.join(root.path, '.git', 'index')),
    status: git(root, 'status', '--porcelain=v1', '-uall'),
    content: fs.readFileSync(path.join(root.path, relativePath), 'utf8'),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  invalidateSessionEnvironment(sessionId)
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-workspace-git-'))
  fixtureDirectory = fs.realpathSync(fixtureDirectory)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(fixtureDirectory, 'gitconfig'))
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0')
  // Read-only status checks must not refresh index bytes used for isolation assertions.
  vi.stubEnv('GIT_OPTIONAL_LOCKS', '0')
  primary = createRepository('primary', 'primary')
  reference = createRepository('reference', 'reference')
  mocks.getSession.mockReturnValue({
    id: sessionId, projectId: primary.id, activeRunId: null, childSessionIds: [],
  })
  mocks.listToolCalls.mockReturnValue([])
  mocks.resolveSessionWorkspaceRoots.mockReturnValue([primary, reference])
})

afterEach(() => {
  invalidateSessionEnvironment(sessionId)
  try {
    if (fixtureDirectory) fs.rmSync(fixtureDirectory, { recursive: true, force: true })
  } finally {
    fixtureDirectory = ''
    vi.unstubAllEnvs()
  }
  expect(mocks.generateGatewayTextResult).not.toHaveBeenCalled()
  expect(mocks.startAuxUsage).not.toHaveBeenCalled()
  expect(mocks.finishAuxUsage).not.toHaveBeenCalled()
})

describe('session workspace Git roots', () => {
  it('reports both repositories and resolves the same relative file path within the selected root', async () => {
    const environment = await getSessionEnvironment(sessionId)

    expect(mocks.resolveSessionWorkspaceRoots).toHaveBeenCalledWith(sessionId, primary.id)
    expect(environment.repositories).toHaveLength(2)
    for (const root of [primary, reference]) {
      expect(environment.repositories.find(repository => repository.rootId === root.id)).toMatchObject({
        rootId: root.id,
        name: root.name,
        role: root.role,
        workspacePath: root.path,
        status: 'ready',
        branch: 'main',
        headCommitSha: git(root, 'rev-parse', 'HEAD').trim(),
        dirty: true,
        additions: 1,
        deletions: 1,
        changedFiles: [
          { path: relativePath, status: 'modified', additions: 1, deletions: 1, staged: true, untracked: false },
        ],
      })
      await expect(getSessionEnvironmentFile(sessionId, relativePath, 'input', root.id)).resolves.toEqual({
        sessionId, path: relativePath, kind: 'input', content: `${root.id} working\n`, truncated: false,
      })
      const diff = await getSessionEnvironmentFile(sessionId, relativePath, 'diff', root.id)
      expect(diff).toMatchObject({ sessionId, path: relativePath, kind: 'diff', truncated: false })
      expect(diff.content).toContain(`-${root.id} before\n+${root.id} working\n`)
      const otherRoot = root.id === primary.id ? reference : primary
      expect(diff.content).not.toContain(`${otherRoot.id} working`)
    }
  })

  it('rejects an empty message without staging or generating', async () => {
    const before = [primary, reference].map(repositoryState)
    await expect(commitSessionWorkspace(sessionId, { rootId: primary.id, message: '  ', push: false }))
      .rejects.toMatchObject({ code: 'GIT_COMMIT_MESSAGE_MISSING' })
    expect([primary, reference].map(repositoryState)).toEqual(before)
  })

  it('commits the selected root only, then lets the other dirty root commit independently', async () => {
    // Keep a cached snapshot so each successful commit must also refresh its repository status.
    await getSessionEnvironment(sessionId)

    // Start with the reference to catch accidental fallback to the primary repository.
    for (const [selected, untouched] of [[reference, primary], [primary, reference]] as const) {
      const selectedBefore = repositoryState(selected)
      const untouchedBefore = repositoryState(untouched)
      expect(selectedBefore.status).toBe(`MM ${relativePath}\n`)
      const message = `test: commit ${selected.id}`

      const result = await commitSessionWorkspace(sessionId, { rootId: selected.id, message, push: false })

      const selectedAfter = repositoryState(selected)
      expect(result).toEqual({
        rootId: selected.id,
        branch: 'main',
        commitSha: selectedAfter.head,
        message,
        messageGenerated: false,
        pushed: null,
        upstream: null,
        committedFiles: 1,
      })
      expect(selectedAfter.head).not.toBe(selectedBefore.head)
      expect(selectedAfter.index).not.toEqual(selectedBefore.index)
      expect(selectedAfter.status).toBe('')
      expect(git(selected, 'show', `HEAD:${relativePath}`)).toBe(`${selected.id} working\n`)
      expect(git(selected, 'show', `:${relativePath}`)).toBe(`${selected.id} working\n`)
      expect(repositoryState(untouched)).toEqual(untouchedBefore)

      const environment = await getSessionEnvironment(sessionId)
      expect(environment.repositories.find(repository => repository.rootId === selected.id)).toMatchObject({
        headCommitSha: selectedAfter.head, dirty: false, changedFiles: [],
      })
      expect(environment.repositories.find(repository => repository.rootId === untouched.id)).toMatchObject({
        headCommitSha: untouchedBefore.head, dirty: untouchedBefore.status !== '',
      })
    }
  }, 20_000) // Two real commits plus per-root index/status snapshots need an integration budget.

  it.each([
    { selector: 'an unknown root', rootId: 'unknown-root', error: 'The selected project is not in this workspace.' },
    { selector: 'an omitted root', rootId: undefined, error: 'Select a workspace project before committing.' },
  ])('rejects $selector before changing either HEAD or index', async ({ rootId, error }) => {
    const before = [primary, reference].map(repositoryState)

    await expect(commitSessionWorkspace(sessionId, {
      ...(rootId === undefined ? {} : { rootId }),
      message: 'test: must not commit',
      push: false,
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: error })

    expect([primary, reference].map(repositoryState)).toEqual(before)
  })

  it('reports missing and non-repository roots separately while preserving healthy repositories', async () => {
    const missing: ProjectWorkspaceRoot = {
      id: 'missing', name: 'Missing project', path: path.join(fixtureDirectory, 'missing'),
      role: 'reference', status: 'missing',
    }
    const nonRepository: ProjectWorkspaceRoot = {
      id: 'plain-directory', name: 'Plain directory', path: path.join(fixtureDirectory, 'plain-directory'),
      role: 'reference', status: 'available',
    }
    fs.mkdirSync(nonRepository.path)
    mocks.resolveSessionWorkspaceRoots.mockReturnValue([primary, reference, missing, nonRepository])

    const environment = await getSessionEnvironment(sessionId)

    expect(environment.repositories.map(({ rootId, status }) => ({ rootId, status }))).toEqual([
      { rootId: primary.id, status: 'ready' },
      { rootId: reference.id, status: 'ready' },
      { rootId: missing.id, status: 'missing' },
      { rootId: nonRepository.id, status: 'not_repository' },
    ])
    for (const root of [primary, reference]) {
      expect(environment.repositories.find(repository => repository.rootId === root.id)).toMatchObject({
        workspacePath: root.path,
        headCommitSha: git(root, 'rev-parse', 'HEAD').trim(),
        dirty: true,
        changedFiles: [{ path: relativePath, status: 'modified' }],
      })
    }
    for (const root of [missing, nonRepository]) {
      expect(environment.repositories.find(repository => repository.rootId === root.id)).toMatchObject({
        workspacePath: root.path, headCommitSha: '', dirty: false, changedFiles: [],
      })
    }
  })

  it('saves an existing file only inside the selected workspace root', async () => {
    await expect(
      saveSessionEnvironmentFile(sessionId, relativePath, 'primary edited\n', primary.id),
    ).resolves.toMatchObject({ path: relativePath, bytes: 15 });
    expect(fs.readFileSync(path.join(primary.path, relativePath), 'utf8')).toBe('primary edited\n');
    expect(fs.readFileSync(path.join(reference.path, relativePath), 'utf8')).toBe('reference working\n');

    await expect(
      saveSessionEnvironmentFile(sessionId, relativePath, 'should not escape\n', 'unknown-root'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('keeps file views and commits compatible with an omitted selector in a one-root workspace', async () => {
    mocks.resolveSessionWorkspaceRoots.mockReturnValue([primary])
    const before = repositoryState(primary)
    const environment = await getSessionEnvironment(sessionId)
    expect(environment.repositories).toHaveLength(1)
    expect(environment).toMatchObject({
      workspacePath: primary.path, headCommitSha: before.head, dirty: true,
      changedFiles: [{ path: relativePath, status: 'modified' }],
    })
    await expect(getSessionEnvironmentFile(sessionId, relativePath, 'input')).resolves.toMatchObject({
      content: 'primary working\n',
    })
    const diff = await getSessionEnvironmentFile(sessionId, relativePath, 'diff')
    expect(diff.content).toContain('-primary before\n+primary working\n')

    const result = await commitSessionWorkspace(sessionId, { message: 'test: single root', push: false })

    const after = repositoryState(primary)
    expect(result).toMatchObject({ rootId: primary.id, commitSha: after.head, messageGenerated: false, pushed: null })
    expect(after.head).not.toBe(before.head)
    expect(after.status).toBe('')
    expect(git(primary, 'show', `HEAD:${relativePath}`)).toBe('primary working\n')
    expect(await getSessionEnvironment(sessionId)).toMatchObject({ headCommitSha: after.head, dirty: false, changedFiles: [] })
  })
})
