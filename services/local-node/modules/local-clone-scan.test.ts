import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findLocalClone, localCloneRoots, normalizeRepoUrl, parseRemoteUrls, readRemoteUrls } from './local-clone-scan.js';

const created: string[] = [];

async function sandbox(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'synax-clone-scan-'));
  created.push(root);
  return root;
}

/** Writes the `remote` part of a repository's config, which is all the scan reads. */
async function writeRepo(root: string, relativePath: string, urls: string[]): Promise<string> {
  const repoPath = path.join(root, relativePath);
  await mkdir(path.join(repoPath, '.git'), { recursive: true });
  const config = ['[core]', '\trepositoryformatversion = 0', ...urls.flatMap(url => ['[remote "origin"]', `\turl = ${url}`, '\tfetch = +refs/heads/*:refs/remotes/origin/*'])].join('\n');
  await writeFile(path.join(repoPath, '.git', 'config'), `${config}\n`, 'utf8');
  return repoPath;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(created.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('repo url normalization', () => {
  it('treats every clone form of one repository as the same key', () => {
    const expected = 'gitlab.example.com/team/hp-finance-server';
    expect(normalizeRepoUrl('https://gitlab.example.com/team/hp-finance-server.git')).toBe(expected);
    expect(normalizeRepoUrl('https://gitlab.example.com/team/hp-finance-server/')).toBe(expected);
    expect(normalizeRepoUrl('git@gitlab.example.com:team/hp-finance-server.git')).toBe(expected);
    expect(normalizeRepoUrl('ssh://git@gitlab.example.com:2222/team/hp-finance-server')).toBe(expected);
    expect(normalizeRepoUrl('  HTTPS://GitLab.Example.COM/Team/HP-Finance-Server.GIT  ')).toBe(expected);
  });

  it('rejects input that cannot identify a repository', () => {
    expect(normalizeRepoUrl('')).toBeNull();
    expect(normalizeRepoUrl('   ')).toBeNull();
    expect(normalizeRepoUrl('not a url')).toBeNull();
  });
});

describe('git records', () => {
  it('reads only remote url entries', () => {
    const config = [
      '[core]',
      '\turl = https://example.test/not-a-remote.git',
      '[remote "origin"]',
      '\turl = git@gitlab.test:group/repo.git',
      '[remote "upstream"]',
      '\turl = https://gitlab.test/group/repo-upstream.git',
    ].join('\n');
    expect(parseRemoteUrls(config)).toEqual(['git@gitlab.test:group/repo.git', 'https://gitlab.test/group/repo-upstream.git']);
  });

  it('follows a linked worktree pointer to the main clone config', async () => {
    const root = await sandbox();
    const main = await writeRepo(root, 'main-repo', ['https://gitlab.test/group/repo.git']);
    const worktree = path.join(root, 'feature-worktree');
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'feature')}\n`, 'utf8');
    expect(await readRemoteUrls(worktree)).toEqual(['https://gitlab.test/group/repo.git']);
  });

  it('reports nothing for a directory that is not a repository', async () => {
    const root = await sandbox();
    await mkdir(path.join(root, 'plain'), { recursive: true });
    expect(await readRemoteUrls(path.join(root, 'plain'))).toEqual([]);
  });
});

describe('local clone discovery', () => {
  const run = () => vi.fn(async () => ({ stdout: '' }));

  it('finds the clone whose recorded remote matches, whatever the url form', async () => {
    const root = await sandbox();
    await writeRepo(root, 'hp-finance-server', ['git@gitlab.example.com:team/hp-finance-server.git']);
    await writeRepo(root, 'other', ['https://gitlab.example.com/team/other.git']);
    const match = await findLocalClone({
      repoUrl: 'https://gitlab.example.com/team/hp-finance-server.git',
      roots: [root],
      run: run() as never,
    });
    expect(match).toMatchObject({ path: path.join(root, 'hp-finance-server'), clean: true });
  });

  it('does not treat a same-named directory as a clone', async () => {
    const root = await sandbox();
    await mkdir(path.join(root, 'hp-finance-server'), { recursive: true });
    const match = await findLocalClone({
      repoUrl: 'https://gitlab.example.com/team/hp-finance-server.git',
      roots: [root],
      run: run() as never,
    });
    expect(match).toBeNull();
  });

  it('prefers the clone named after the project', async () => {
    const root = await sandbox();
    await writeRepo(root, 'repos/copy-of-hp-finance', ['https://gitlab.test/group/hp-finance-server.git']);
    await writeRepo(root, 'hp-finance-server', ['https://gitlab.test/group/hp-finance-server.git']);
    const match = await findLocalClone({
      repoUrl: 'https://gitlab.test/group/hp-finance-server.git',
      preferredName: 'hp-finance-server',
      roots: [root],
      run: run() as never,
    });
    expect(match?.path).toBe(path.join(root, 'hp-finance-server'));
  });

  it('walks bounded depth and skips build output', async () => {
    const root = await sandbox();
    await writeRepo(root, 'a/b/c', ['https://gitlab.test/group/deep.git']);
    await writeRepo(root, 'a/node_modules', ['https://gitlab.test/group/vendored.git']);
    const shallow = await findLocalClone({
      repoUrl: 'https://gitlab.test/group/deep.git',
      roots: [root],
      maxDepth: 2,
      run: run() as never,
    });
    const deep = await findLocalClone({
      repoUrl: 'https://gitlab.test/group/deep.git',
      roots: [root],
      maxDepth: 3,
      run: run() as never,
    });
    const skipped = await findLocalClone({
      repoUrl: 'https://gitlab.test/group/vendored.git',
      roots: [root],
      run: run() as never,
    });
    expect(shallow).toBeNull();
    expect(deep?.path).toBe(path.join(root, 'a/b/c'));
    expect(skipped).toBeNull();
  });

  it('marks a clone with uncommitted changes as not reusable', async () => {
    const root = await sandbox();
    await writeRepo(root, 'dirty-repo', ['https://gitlab.test/group/dirty.git']);
    const match = await findLocalClone({
      repoUrl: 'https://gitlab.test/group/dirty.git',
      roots: [root],
      run: vi.fn(async () => ({ stdout: ' M src/index.ts\n' })) as never,
    });
    expect(match).toMatchObject({ clean: false });
  });

  it('falls back to a clean clone when the closest one is dirty', async () => {
    const root = await sandbox();
    await writeRepo(root, 'dirty-repo', ['https://gitlab.test/group/repo.git']);
    await writeRepo(root, 'clean-copy-of-repo', ['https://gitlab.test/group/repo.git']);
    const status = vi.fn(async (_args: string[], cwd: string) => ({ stdout: cwd.endsWith('dirty-repo') ? ' M a.ts\n' : '' }));
    const match = await findLocalClone({
      repoUrl: 'https://gitlab.test/group/repo.git',
      preferredName: 'dirty-repo',
      roots: [root],
      run: status as never,
    });
    expect(match).toMatchObject({ path: path.join(root, 'clean-copy-of-repo'), clean: true });
  });

  it('stops at its time budget instead of delaying a workspace', async () => {
    const root = await sandbox();
    await writeRepo(root, 'hp-finance-server', ['https://gitlab.test/group/hp-finance-server.git']);
    let clock = 0;
    const match = await findLocalClone({
      repoUrl: 'https://gitlab.test/group/hp-finance-server.git',
      roots: [root],
      budgetMs: 0,
      now: () => (clock += 1_000),
      run: run() as never,
    });
    expect(match).toBeNull();
  });

  it('keeps scanning the remaining roots when one is unreadable', async () => {
    const root = await sandbox();
    const found = await writeRepo(root, 'repo', ['https://gitlab.test/group/repo.git']);
    const match = await findLocalClone({
      repoUrl: 'https://gitlab.test/group/repo.git',
      roots: [path.join(root, 'does-not-exist'), root],
      run: run() as never,
    });
    expect(match?.path).toBe(found);
  });
});

describe('scan roots', () => {
  it('lets the environment replace the default roots', () => {
    expect(localCloneRoots({ SYNAX_LOCAL_CLONE_ROOTS: `/one${path.delimiter}/two` })).toEqual(['/one', '/two']);
    expect(localCloneRoots({})).toContain(path.join(userInfo().homedir, 'IdeaProjects'));
  });
});
