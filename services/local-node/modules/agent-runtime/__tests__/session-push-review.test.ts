import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ root: vi.fn(), invalidate: vi.fn() }));
vi.mock('../session-store.js', () => ({ agentRuntimeStore: { getSession: () => ({ id: 's', projectId: 'p' }) } }));
vi.mock('../session-environment.js', () => ({ resolveSessionRepository: mocks.root, invalidateSessionEnvironment: mocks.invalidate }));
vi.mock('../session-git-branches.js', () => ({ switchSessionGitBranch: vi.fn() }));
// Conflict resolution needs a model; keep the push path deterministic.
vi.mock('../../../infrastructure/llm-runtime/gateway.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateGatewayTextResult: vi.fn().mockRejectedValue(new Error('gateway unavailable')),
}));
import { listSessionWorkspaceCommits, pushSessionWorkspace } from '../session-git-commit.js';
let directory: string;
let repo: string;
let remote: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (subject: string) => { git('commit', '--allow-empty', '-qm', subject); return git('rev-parse', 'HEAD'); };
beforeEach(() => {
  vi.clearAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-push-review-'));
  repo = path.join(directory, 'checkout');
  remote = path.join(directory, 'remote.git');
  fs.mkdirSync(repo);
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(directory, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  git('init', '-q', '--initial-branch=main', '--template=');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('init', '-q', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  commit('initial');
  git('push', '-qu', 'origin', 'main');
  mocks.root.mockReturnValue({ id: 'root', path: repo });
});
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
it('reviews only outgoing commits with bodies and preserves uncommitted files', async () => {
  const first = commit('feat: review\n\nMultiple lines\nincluding \x1e record separator');
  const second = commit('fix: button');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'keep me');
  const before = git('status', '--porcelain');
  const review = await listSessionWorkspaceCommits('s', { rootId: 'root' });
  expect(review).toMatchObject({ rootId: 'root', branch: 'main', headCommitSha: second, upstream: 'origin/main' });
  expect(review.commits.map(c => c.sha)).toEqual([first, second]);
  expect(review.commits[0]).toMatchObject({ author: 'Test', subject: 'feat: review', body: 'Multiple lines\nincluding \x1e record separator' });
  expect(git('status', '--porcelain')).toBe(before);
  expect(mocks.root).toHaveBeenCalledWith('s', 'p', 'root', true);
  await pushSessionWorkspace('s', { rootId: 'root', expectedHeadSha: review.headCommitSha, expectedBranch: review.branch, expectedUpstream: review.upstream });
  expect((await listSessionWorkspaceCommits('s', { rootId: 'root' })).commits).toEqual([]);
  expect(git('status', '--porcelain')).toBe(before);
});
it('reviews and publishes a branch without an upstream', async () => {
  git('checkout', '-qb', 'feature/review');
  const sha = commit('feature');
  const review = await listSessionWorkspaceCommits('s');
  expect(review.commits.map(c => c.sha)).toEqual([sha]);
  expect(review.upstream).toBe('origin/feature/review');
  await pushSessionWorkspace('s', { expectedHeadSha: sha, expectedBranch: review.branch, expectedUpstream: review.upstream });
  expect(git('rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feature/review');
});
it('rejects changes made after review without sending unreviewed commits', async () => {
  const sha = commit('reviewed');
  commit('unreviewed');
  await expect(pushSessionWorkspace('s', { expectedHeadSha: sha, expectedBranch: 'main', expectedUpstream: 'origin/main' })).rejects.toMatchObject({ code: 'GIT_PUSH_REVIEW_CHANGED' });
  expect(git('rev-list', '--count', 'origin/main..HEAD')).toBe('2');
});
it('uses the reviewed upstream even if push.default and pushRemote differ', async () => {
  git('checkout', '-qb', 'topic');
  git('branch', '--set-upstream-to=origin/main');
  git('config', 'branch.topic.pushRemote', 'missing');
  git('config', 'push.default', 'matching');
  const sha = commit('topic');
  const review = await listSessionWorkspaceCommits('s');
  await pushSessionWorkspace('s', { expectedHeadSha: sha, expectedBranch: review.branch, expectedUpstream: review.upstream });
  expect(git('rev-parse', 'origin/main')).toBe(sha);
});
it('does not silently omit older commits from a long review', async () => {
  for (let index = 0; index < 205; index++) commit(`change ${index}`);
  expect((await listSessionWorkspaceCommits('s')).commits).toHaveLength(205);
}, 30000);

const gitAt = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A second checkout that publishes to the same remote while this session works. */
function createPeer(): string {
  const peer = path.join(directory, 'peer');
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remote });
  execFileSync('git', ['clone', '-q', remote, peer], { cwd: directory, encoding: 'utf8' });
  gitAt(peer, 'config', 'user.name', 'Peer');
  gitAt(peer, 'config', 'user.email', 'peer@example.com');
  gitAt(peer, 'config', 'commit.gpgsign', 'false');
  return peer;
}

it('pulls the remote branch before publishing instead of rejecting the push', async () => {
  fs.writeFileSync(path.join(repo, 'local.txt'), 'local\n');
  git('add', '.');
  const local = commit('local work');

  const peer = createPeer();
  fs.writeFileSync(path.join(peer, 'remote.txt'), 'remote\n');
  gitAt(peer, 'add', '.');
  gitAt(peer, 'commit', '-qm', 'remote work');
  gitAt(peer, 'push', '-q', 'origin', 'main');
  const peerHead = gitAt(peer, 'rev-parse', 'HEAD');

  await pushSessionWorkspace('s', {
    expectedHeadSha: local,
    expectedBranch: 'main',
    expectedUpstream: 'origin/main',
  });

  // The sync merged the remote work into a merge commit and published both sides.
  expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
  expect(git('show', 'HEAD:remote.txt')).toBe('remote');
  expect(git('show', 'HEAD:local.txt')).toBe('local');
  expect(gitAt(remote, 'show', 'main:local.txt')).toBe('local');
  expect(gitAt(remote, 'show', 'main:remote.txt')).toBe('remote');
  expect(git('merge-base', '--is-ancestor', peerHead, 'HEAD')).toBe('');
});

it('stops the push on a pull conflict and keeps the merge for resolution', async () => {
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
  git('add', '.');
  commit('base');
  git('push', '-q', 'origin', 'main');

  fs.writeFileSync(path.join(repo, 'shared.txt'), 'local\n');
  git('add', '.');
  const local = commit('local edit');

  const peer = createPeer();
  fs.writeFileSync(path.join(peer, 'shared.txt'), 'remote\n');
  gitAt(peer, 'add', '.');
  gitAt(peer, 'commit', '-qm', 'peer edit');
  gitAt(peer, 'push', '-q', 'origin', 'main');

  await expect(
    pushSessionWorkspace('s', {
      expectedHeadSha: local,
      expectedBranch: 'main',
      expectedUpstream: 'origin/main',
    }),
  ).rejects.toMatchObject({ code: 'GIT_PULL_CONFLICTS', status: 409 });

  // Nothing was published, and the conflicting merge is still resolvable.
  expect(gitAt(remote, 'show', 'main:shared.txt')).toBe('remote');
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
  expect(git('status', '--porcelain')).toContain('UU shared.txt');
});

it('refuses to pull while the index holds uncommitted staged work', async () => {
  const peer = createPeer();
  fs.writeFileSync(path.join(peer, 'remote.txt'), 'remote\n');
  gitAt(peer, 'add', '.');
  gitAt(peer, 'commit', '-qm', 'remote work');
  gitAt(peer, 'push', '-q', 'origin', 'main');

  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
  git('add', 'staged.txt');

  await expect(pushSessionWorkspace('s', { rootId: 'root' })).rejects.toMatchObject({
    code: 'GIT_PUSH_STAGED_CHANGES',
    status: 409,
  });
  // Nothing was merged or published behind the user's back.
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
  expect(gitAt(remote, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('staged.txt');
});
