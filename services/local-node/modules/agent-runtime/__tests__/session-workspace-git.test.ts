import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectWorkspaceRoot } from '../../project-workspace.js'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  tryGetSession: vi.fn(),
  listToolCalls: vi.fn(),
  resolveSessionWorkspaceRoots: vi.fn(),
  resolveWorkspaceRootsFromSession: vi.fn(),
  generateGatewayTextResult: vi.fn(),
  startAuxUsage: vi.fn(),
  finishAuxUsage: vi.fn(),
}))

vi.mock('../session-store.js', () => ({
  agentRuntimeStore: {
    getSession: mocks.getSession,
    tryGetSession: mocks.tryGetSession,
    listMessages: () => [],
    listToolCalls: mocks.listToolCalls,
  },
}))
vi.mock('../tools/workspace.js', () => ({
  resolveSessionWorkspaceRoots: mocks.resolveSessionWorkspaceRoots,
  resolveWorkspaceRootsFromSession: mocks.resolveWorkspaceRootsFromSession,
}))
vi.mock('../../../infrastructure/llm-runtime/gateway.js', () => ({ generateGatewayTextResult: mocks.generateGatewayTextResult }))
vi.mock('../usage-projection.js', () => ({ startAuxUsage: mocks.startAuxUsage, finishAuxUsage: mocks.finishAuxUsage }))
vi.mock('../../../infrastructure/runtime/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

import {
  getSessionEnvironmentFile,
  getSessionEnvironmentFileMedia,
  saveSessionEnvironmentFile,
  invalidateSessionEnvironment,
} from '../session-environment.js'
import { getWorkspaceGitChanges } from '../workspace-git-changes.js'
import { commitSessionWorkspace, pushSessionWorkspace } from '../session-git-commit.js'

const sessionId = 'multi-root-workspace-git-test'
const relativePath = 'src/shared.txt'
let fixtureDirectory = ''
let primary: ProjectWorkspaceRoot
let reference: ProjectWorkspaceRoot
let expectConflictModel = false

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

const readWorkspace = () => getWorkspaceGitChanges({ projectId: primary.id, sessionId })

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
  mocks.generateGatewayTextResult.mockReset()
  expectConflictModel = false
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
  const sessionRecord = {
    id: sessionId, projectId: primary.id, activeRunId: null, childSessionIds: [],
  }
  mocks.getSession.mockReturnValue(sessionRecord)
  mocks.tryGetSession.mockReturnValue(sessionRecord)
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
  if (!expectConflictModel) {
    expect(mocks.generateGatewayTextResult).not.toHaveBeenCalled()
    expect(mocks.startAuxUsage).not.toHaveBeenCalled()
    expect(mocks.finishAuxUsage).not.toHaveBeenCalled()
  } else {
    expect(mocks.generateGatewayTextResult).toHaveBeenCalled()
    expect(mocks.startAuxUsage).toHaveBeenCalledWith(sessionId, 'git-conflict-resolution')
    expect(mocks.finishAuxUsage).toHaveBeenCalled()
  }
})

describe('session workspace Git roots', () => {
  it('reports both repositories and resolves the same relative file path within the selected root', async () => {
    const environment = await readWorkspace()

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
        sessionId, path: relativePath, kind: 'input', content: `${root.id} working\n`, truncated: false, workspacePath: root.path,
      })
      const diff = await getSessionEnvironmentFile(sessionId, relativePath, 'diff', root.id)
      expect(diff).toMatchObject({ sessionId, path: relativePath, kind: 'diff', truncated: false })
      expect(diff.content).toContain(`-${root.id} before\n+${root.id} working\n`)
      const otherRoot = root.id === primary.id ? reference : primary
      expect(diff.content).not.toContain(`${otherRoot.id} working`)
    }
  })

  it('resolves an unscoped file reference from the repository that contains it', async () => {
    const referenceOnlyPath = 'sql/reference-only.sql'
    fs.mkdirSync(path.dirname(path.join(reference.path, referenceOnlyPath)), { recursive: true })
    fs.writeFileSync(path.join(reference.path, referenceOnlyPath), 'reference-only\n')

    await expect(getSessionEnvironmentFile(sessionId, referenceOnlyPath, 'input')).resolves.toEqual({
      sessionId,
      path: referenceOnlyPath,
      kind: 'input',
      content: 'reference-only\n',
      truncated: false,
      workspacePath: reference.path,
    })
  })

  it('reads validated image bytes without UTF-8 conversion', async () => {
    const imagePath = 'assets/pixel.png'
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    const target = path.join(primary.path, imagePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)

    await expect(
      getSessionEnvironmentFileMedia(sessionId, imagePath, primary.id),
    ).resolves.toMatchObject({
      sessionId,
      path: imagePath,
      mediaType: 'image/png',
      bytes,
    })
    await expect(
      getSessionEnvironmentFileMedia(sessionId, relativePath, primary.id),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it.each([
    ['sample.wav', Buffer.from('RIFF0000WAVEdata'), 'audio/wav'],
    ['sample.mp4', Buffer.from('0000ftypisom0000'), 'video/mp4'],
  ] as const)('preserves native media preview bytes for %s', async (filename, bytes, mediaType) => {
    fs.writeFileSync(path.join(primary.path, filename), bytes);
    await expect(getSessionEnvironmentFileMedia(sessionId, filename, primary.id)).resolves.toMatchObject({ mediaType, bytes });
  });

  it('rejects an empty message without staging or generating', async () => {
    const before = [primary, reference].map(repositoryState)
    await expect(commitSessionWorkspace(sessionId, { rootId: primary.id, message: '  ', push: false }))
      .rejects.toMatchObject({ code: 'GIT_COMMIT_MESSAGE_MISSING' })
    expect([primary, reference].map(repositoryState)).toEqual(before)
  })

  it('allows committing while the session is running without changing its active run', async () => {
    const session = {
      id: sessionId, projectId: primary.id, status: 'running', activeRunId: 'active-run', childSessionIds: [],
    }
    mocks.getSession.mockReturnValue(session)
    const beforeHead = git(primary, 'rev-parse', 'HEAD').trim()
    const referenceBefore = repositoryState(reference)

    const result = await commitSessionWorkspace(sessionId, {
      rootId: primary.id, message: 'test: commit during active run', push: false,
    })

    expect(result.commitSha).not.toBe(beforeHead)
    expect(result.commitSha).toBe(git(primary, 'rev-parse', 'HEAD').trim())
    expect(git(primary, 'show', `HEAD:${relativePath}`)).toBe('primary working\n')
    expect(git(primary, 'status', '--porcelain=v1')).toBe('')
    expect(repositoryState(reference)).toEqual(referenceBefore)
    expect(session).toMatchObject({ status: 'running', activeRunId: 'active-run' })
  })

  it('commits while ignored .DS_Store files exist instead of failing the staging step', async () => {
    // Mirrors a macOS checkout: the repository ignores Finder metadata and both
    // the root and a nested copy exist, so `git add` must skip them silently.
    fs.writeFileSync(path.join(primary.path, '.gitignore'), '.DS_Store\n')
    fs.writeFileSync(path.join(primary.path, '.DS_Store'), 'metadata')
    fs.mkdirSync(path.join(primary.path, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(primary.path, 'nested', '.DS_Store'), 'metadata')

    const result = await commitSessionWorkspace(sessionId, {
      rootId: primary.id, message: 'test: commit with .DS_Store present', push: false,
    })

    expect(result.committedFiles).toBe(2) // relativePath plus the new .gitignore
    expect(git(primary, 'ls-files')).not.toContain('.DS_Store')
    expect(git(primary, 'status', '--porcelain=v1', '-uall')).toBe('')
  })

  it('never stages an untracked .DS_Store that Git does not ignore', async () => {
    fs.writeFileSync(path.join(reference.path, '.DS_Store'), 'metadata')
    fs.mkdirSync(path.join(reference.path, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(reference.path, 'nested', '.DS_Store'), 'metadata')

    const result = await commitSessionWorkspace(sessionId, {
      rootId: reference.id, message: 'test: skip untracked .DS_Store', push: false,
    })

    expect(result.committedFiles).toBe(1)
    expect(git(reference, 'ls-files')).not.toContain('.DS_Store')
    expect(git(reference, 'status', '--porcelain=v1', '-uall')).toBe('?? .DS_Store\n?? nested/.DS_Store\n')
  })

  it('commits the selected root only, then lets the other dirty root commit independently', async () => {
    // Keep cached Git facts so each successful commit must also refresh its repository status.
    await readWorkspace()

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

      const environment = await readWorkspace()
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

    const environment = await readWorkspace()

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
    const environment = await readWorkspace()
    expect(environment.repositories).toHaveLength(1)
    expect(environment.repositories[0]).toMatchObject({
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
    expect((await readWorkspace()).repositories[0]).toMatchObject({ headCommitSha: after.head, dirty: false, changedFiles: [] })
  })
})

describe('detached session commit', () => {
  it('requires a branch name before committing, then attaches at HEAD and preserves edits', async () => {
    git(primary, 'switch', '--detach')
    expect((await readWorkspace()).repositories.find(root => root.rootId === primary.id)?.branch).toBe('HEAD')
    const before = git(primary, 'rev-parse', 'HEAD').trim()
    await expect(commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'test: detached', push: false }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(git(primary, 'branch', '--show-current').trim()).toBe('')
    const result = await commitSessionWorkspace(sessionId, {
      rootId: primary.id, message: 'test: detached', branchName: 'topic/new-session', push: false,
    })
    expect(result.branch).toBe('topic/new-session')
    expect(git(primary, 'branch', '--show-current').trim()).toBe('topic/new-session')
    expect(result.commitSha).not.toBe(before)
    expect(git(primary, 'show', `HEAD:${relativePath}`)).toBe('primary working\n')
    expect(git(reference, 'branch', '--show-current').trim()).toBe('main')
  }, 20_000)

  it('creates the branch before push and publishes that branch, never a detached HEAD', async () => {
    git(primary, 'switch', '--detach')
    const remote = path.join(fixtureDirectory, 'remote.git')
    execFileSync('git', ['init', '--bare', remote], { cwd: fixtureDirectory })
    git(primary, 'remote', 'add', 'origin', remote)
    const result = await commitSessionWorkspace(sessionId, {
      rootId: primary.id, message: 'test: push detached', branchName: 'topic/push-session',
    })
    expect(result).toMatchObject({ branch: 'topic/push-session', pushed: true, upstream: 'origin/topic/push-session' })
    expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/topic/push-session'], { encoding: 'utf8' }).trim()).toBe(result.commitSha)
  }, 20_000)
})

describe('detached branch creation retry', () => {
  it('does not create a branch for an invalid commit, and retries safely after a failed hook', async () => {
    git(primary, 'switch', '--detach')
    await expect(commitSessionWorkspace(sessionId, {
      rootId: primary.id, message: '', branchName: 'topic/retry', push: false,
    })).rejects.toMatchObject({ code: 'GIT_COMMIT_MESSAGE_MISSING' })
    expect(git(primary, 'branch', '--show-current').trim()).toBe('')

    const hooks = path.join(fixtureDirectory, 'hooks')
    fs.mkdirSync(hooks)
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    git(primary, 'config', 'core.hooksPath', hooks)
    await expect(commitSessionWorkspace(sessionId, {
      rootId: primary.id, message: 'test: retry', branchName: 'topic/retry', push: false,
    })).rejects.toMatchObject({ code: 'GIT_COMMIT_FAILED' })
    expect(git(primary, 'branch', '--show-current').trim()).toBe('topic/retry')
    git(primary, 'config', '--unset', 'core.hooksPath')
    const result = await commitSessionWorkspace(sessionId, {
      rootId: primary.id, message: 'test: retry', branchName: 'topic/retry', push: false,
    })
    expect(result.branch).toBe('topic/retry')
  }, 20_000)
})

describe('conflict-safe commit and push', () => {
  function createConflict(): void {
    git(primary, 'reset', '--hard', 'HEAD')
    git(primary, 'checkout', '-qb', 'conflict-source')
    writeSharedFile(primary, 'source\n')
    git(primary, 'add', '--', relativePath)
    git(primary, 'commit', '--quiet', '-m', 'source change')
    git(primary, 'checkout', '-q', 'main')
    writeSharedFile(primary, 'target\n')
    git(primary, 'add', '--', relativePath)
    git(primary, 'commit', '--quiet', '-m', 'target change')
    try {
      git(primary, 'merge', 'conflict-source')
    } catch {
      // The fixture intentionally leaves Git in an unresolved merge state.
    }
  }

  it('rejects competing conflict markers without changing HEAD or the index', async () => {
    createConflict()
    expectConflictModel = true
    mocks.generateGatewayTextResult.mockResolvedValue({ finishReason: 'stop', text: '{"resolutions":[null]}' })
    const before = repositoryState(primary)

    await expect(commitSessionWorkspace(sessionId, {
      rootId: primary.id,
      message: 'test: do not commit unresolved conflict',
      push: false,
    })).rejects.toMatchObject({ code: 'GIT_UNRESOLVED_CONFLICTS' })

    expect(repositoryState(primary)).toEqual(before)
    expect(git(primary, 'status', '--porcelain=v1')).toBe(`UU ${relativePath}\n`)
  }, 20_000)

  it('automatically stages an unambiguous conflict resolution before committing', async () => {
    createConflict()
    fs.writeFileSync(
      path.join(primary.path, relativePath),
      '<<<<<<< HEAD\nsame\n=======\nsame\n>>>>>>> conflict-source\n',
    )

    const result = await commitSessionWorkspace(sessionId, {
      rootId: primary.id,
      message: 'test: resolve conflict automatically',
      push: false,
    })

    expect(result.pushed).toBeNull()
    expect(git(primary, 'status', '--porcelain=v1')).toBe('')
    expect(git(primary, 'show', `HEAD:${relativePath}`)).toBe('same\n')
    expect(git(primary, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
  }, 20_000)

  it('never pushes a branch while its worktree has an unresolved conflict', async () => {
    createConflict()

    await expect(pushSessionWorkspace(sessionId, { rootId: primary.id }))
      .rejects.toMatchObject({ code: 'GIT_UNRESOLVED_CONFLICTS' })
    expect(git(primary, 'status', '--porcelain=v1')).toBe(`UU ${relativePath}\n`)
  }, 20_000)

  function remoteForPrimary(): string {
    const remote = path.join(fixtureDirectory, 'remote.git')
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote])
    git(primary, 'remote', 'add', 'origin', remote)
    git(primary, 'push', '--quiet', '-u', 'origin', 'main')
    return remote
  }

  it('automatically resolves competing edits with the project model, then commits and pushes clean content', async () => {
    createConflict()
    const remote = remoteForPrimary()
    const untouched = repositoryState(reference)
    expectConflictModel = true
    mocks.generateGatewayTextResult.mockResolvedValue({ finishReason: 'stop', text: JSON.stringify({ resolutions: ['target and source\n'] }) })
    const result = await commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'fix: combine both changes' })
    expect(result.pushed).toBe(true)
    expect(git(primary, 'show', `HEAD:${relativePath}`)).toBe('target and source\n')
    expect(execFileSync('git', ['--git-dir', remote, 'show', `main:${relativePath}`], { encoding: 'utf8' })).toBe('target and source\n')
    expect(repositoryState(reference)).toEqual(untouched)
    const request = mocks.generateGatewayTextResult.mock.calls[0][0]
    expect(request).toMatchObject({ projectId: primary.id, purpose: 'git-conflict-resolution' })
    expect(JSON.parse(request.messages[1].content).sides).toEqual({ base: 'primary before\n', ours: 'target\n', theirs: 'source\n' })
  }, 20_000)

  it('resolves already staged marker content before committing', async () => {
    createConflict()
    git(primary, 'add', '--', relativePath)
    expectConflictModel = true
    mocks.generateGatewayTextResult.mockResolvedValue({ finishReason: 'stop', text: JSON.stringify({ resolutions: ['combined\n'] }) })
    await commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'fix: staged conflict', push: false })
    expect(git(primary, 'show', `HEAD:${relativePath}`)).toBe('combined\n')
  }, 20_000)

  it.each(['length', 'invalid', 'markers', 'unavailable'])('preserves every file when model resolution is %s', async kind => {
    createConflict()
    expectConflictModel = true
    const before = repositoryState(primary)
    if (kind === 'unavailable') mocks.generateGatewayTextResult.mockRejectedValue(new Error('Provider unavailable'))
    else mocks.generateGatewayTextResult.mockResolvedValue({
      finishReason: kind === 'length' ? 'length' : 'stop',
      text: kind === 'invalid' ? 'not JSON' : JSON.stringify({ resolutions: [kind === 'markers' ? '<<<<<<< still broken\n' : 'partial'] }),
    })
    await expect(commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'fix: resolve', push: false })).rejects.toMatchObject({ code: 'GIT_UNRESOLVED_CONFLICTS' })
    expect(repositoryState(primary)).toEqual(before)
  }, 20_000)

  it('does not overwrite an edit made while the model is resolving', async () => {
    createConflict()
    const beforeHead = git(primary, 'rev-parse', 'HEAD')
    expectConflictModel = true
    mocks.generateGatewayTextResult.mockImplementation(async () => {
      writeSharedFile(primary, 'concurrent edit\n')
      return { finishReason: 'stop', text: JSON.stringify({ resolutions: ['combined\n'] }) }
    })
    await expect(commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'fix: resolve', push: false })).rejects.toMatchObject({ code: 'GIT_CONFLICT_STATE_CHANGED' })
    expect(fs.readFileSync(path.join(primary.path, relativePath), 'utf8')).toBe('concurrent edit\n')
    expect(git(primary, 'rev-parse', 'HEAD')).toBe(beforeHead)
    expect(git(primary, 'ls-files', '-u')).not.toBe('')
  }, 20_000)

  it.each(['binary', 'delete'])('does not silently stage a %s conflict without markers', async kind => {
    git(primary, 'reset', '--hard', 'HEAD')
    const base = kind === 'binary' ? 'base\0bytes' : 'base\n'
    writeSharedFile(primary, base)
    git(primary, 'commit', '-qam', 'base')
    git(primary, 'checkout', '-qb', 'structural-conflict')
    if (kind === 'delete') git(primary, 'rm', '--', relativePath)
    else writeSharedFile(primary, 'source\0bytes')
    git(primary, 'commit', '-qam', 'source')
    git(primary, 'checkout', '-q', 'main')
    writeSharedFile(primary, kind === 'binary' ? 'target\0bytes' : 'target\n')
    git(primary, 'commit', '-qam', 'target')
    try { git(primary, 'merge', 'structural-conflict') } catch { /* expected */ }
    const before = repositoryState(primary)
    await expect(commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'fix: resolve', push: false })).rejects.toMatchObject({ code: 'GIT_UNRESOLVED_CONFLICTS' })
    expect(repositoryState(primary)).toEqual(before)
  }, 20_000)

  it('does not inspect or stage excluded untracked conflicts', async () => {
    fs.writeFileSync(path.join(primary.path, 'untracked.txt'), '<<<<<<< a\na\n=======\nb\n>>>>>>> b\n')
    await commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'fix: tracked only', push: false, includeUntracked: false })
    expect(git(primary, 'ls-files')).not.toContain('untracked.txt')
  }, 20_000)

  it('does not misread rename source records or trim paths while resolving', async () => {
    const renamed = 'src/ 空格\n文件 .txt '
    git(primary, 'mv', relativePath, renamed)
    fs.writeFileSync(path.join(primary.path, renamed), '<<<<<<< a\nsame\n=======\nsame\n>>>>>>> b\n')
    await commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'fix: renamed conflict', push: false })
    expect(git(primary, 'show', `HEAD:${renamed}`)).toBe('same\n')
  }, 20_000)

  it('blocks pushing conflict markers in outgoing history even if a later commit fixed them', async () => {
    git(primary, 'reset', '--hard', 'HEAD')
    const remote = remoteForPrimary()
    const remoteHead = git(primary, 'rev-parse', 'HEAD').trim()
    writeSharedFile(primary, '<<<<<<< a\na\n=======\nb\n>>>>>>> b\n')
    git(primary, 'commit', '-qam', 'bad commit')
    writeSharedFile(primary, 'fixed\n')
    git(primary, 'commit', '-qam', 'fix markers')
    await expect(pushSessionWorkspace(sessionId, { rootId: primary.id })).rejects.toMatchObject({ code: 'GIT_UNRESOLVED_CONFLICTS' })
    expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(remoteHead)
  }, 20_000)

  it('rejects conflict markers introduced by a clean filter into the actual index', async () => {
    const filter = path.join(fixtureDirectory, 'filter.cjs')
    fs.writeFileSync(filter, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('<<<<<<< filter\\na\\n=======\\nb\\n>>>>>>> filter\\n'));\n")
    git(primary, 'config', 'filter.inject.clean', `node "${filter}"`)
    fs.writeFileSync(path.join(primary.path, '.gitattributes'), `${relativePath} filter=inject\n`)
    const head = git(primary, 'rev-parse', 'HEAD')
    await expect(commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'fix: clean filter', push: false })).rejects.toMatchObject({ code: 'GIT_UNRESOLVED_CONFLICTS' })
    expect(git(primary, 'rev-parse', 'HEAD')).toBe(head)
  }, 20_000)

  it('rejects oversized text conflicts without staging or truncating them', async () => {
    const content = 'x'.repeat(140_000) + '\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n'
    writeSharedFile(primary, content)
    const before = repositoryState(primary)
    await expect(commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'fix: huge', push: false })).rejects.toMatchObject({ code: 'GIT_UNRESOLVED_CONFLICTS' })
    expect(repositoryState(primary)).toEqual(before)
  }, 20_000)

  it('does not write any successful resolutions when another file remains ambiguous', async () => {
    createConflict()
    const extra = path.join(primary.path, 'another.txt')
    const safe = '<<<<<<< ours\nsame\n=======\nsame\n>>>>>>> theirs\n'
    fs.writeFileSync(extra, safe)
    expectConflictModel = true
    mocks.generateGatewayTextResult.mockResolvedValue({ finishReason: 'stop', text: '{"resolutions":[null]}' })
    const before = repositoryState(primary)
    await expect(commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'fix: all or none', push: false })).rejects.toMatchObject({ code: 'GIT_UNRESOLVED_CONFLICTS' })
    expect(repositoryState(primary)).toEqual(before)
    expect(fs.readFileSync(extra, 'utf8')).toBe(safe)
  }, 20_000)

  it('finishes a resolved merge even when the result matches HEAD', async () => {
    createConflict()
    writeSharedFile(primary, '<<<<<<< ours\ntarget\n=======\ntarget\n>>>>>>> theirs\n')
    const result = await commitSessionWorkspace(sessionId, { rootId: primary.id, message: 'fix: record merge', push: false })
    expect(result.committedFiles).toBe(0)
    expect(git(primary, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3)
  }, 20_000)

  it('does not create a new named branch in the middle of a rebase', async () => {
    git(primary, 'switch', '--detach')
    fs.mkdirSync(path.join(primary.path, '.git', 'rebase-merge'))
    const before = repositoryState(primary)
    await expect(commitSessionWorkspace(sessionId, { rootId: primary.id, branchName: 'topic/must-not-exist', message: 'fix: no rebase', push: false }))
      .rejects.toMatchObject({ code: 'GIT_OPERATION_IN_PROGRESS' })
    expect(repositoryState(primary)).toEqual(before)
    expect(git(primary, 'branch', '--list', 'topic/must-not-exist')).toBe('')
  }, 20_000)

  it('allows an ordinary push without staging dirty worktree files', async () => {
    const remote = remoteForPrimary()
    git(primary, 'commit', '-qam', 'outgoing')
    writeSharedFile(primary, 'keep uncommitted\n')
    const before = repositoryState(primary)
    const result = await pushSessionWorkspace(sessionId, { rootId: primary.id })
    expect(result.pushed).toBe(true)
    expect(repositoryState(primary)).toEqual(before)
    expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(before.head)
  }, 20_000)
})
