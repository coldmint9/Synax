import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloneRepository, GitCloneError, parseCloneRemote } from './git-clone.js';

type CloneRunner = NonNullable<Parameters<typeof cloneRepository>[0]['run']>;

const roots: string[] = [];
function destination() {
  const root = mkdtempSync(path.join(tmpdir(), 'synax-clone-'));
  roots.push(root);
  return path.join(root, 'repo');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('git clone', () => {
  it('accepts common hosted remote forms and rejects option smuggling', () => {
    expect(parseCloneRemote('https://git.example.test/a/b.git')).toMatchObject({ host: 'git.example.test', https: true });
    expect(parseCloneRemote('git@git.example.test:a/b.git')).toMatchObject({ host: 'git.example.test', https: false });
    expect(parseCloneRemote('ssh://git@git.example.test/a/b.git')).toMatchObject({ host: 'git.example.test' });
    expect(() => parseCloneRemote('--upload-pack=evil')).toThrow(GitCloneError);
    expect(() => parseCloneRemote('file:///etc/passwd')).toThrow(GitCloneError);
  });

  it('passes a host token through git config, never argv', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await cloneRepository({
      repoUrl: 'https://git.example.test/group/repo.git',
      destination: destination(),
      token: 'secret-token',
      run: run as unknown as CloneRunner,
    });

    const [command, args, options] = run.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(command).toBe('git');
    expect(args).toEqual(['clone', 'https://git.example.test/group/repo.git', expect.any(String)]);
    expect(args.join(' ')).not.toContain('secret-token');
    expect(options.env.GIT_CONFIG_VALUE_0).toContain(Buffer.from('oauth2:secret-token').toString('base64'));
    expect(options.env.GIT_CONFIG_KEY_0).toBe('http.https://git.example.test/.extraHeader');
  });

  it('removes a half-written directory and explains the failure', async () => {
    const target = destination();
    const run = vi.fn(async () => {
      throw Object.assign(new Error('exit 128'), { stderr: 'remote: Repository not found.\nfatal: repository not found\n' });
    });
    await expect(cloneRepository({ repoUrl: 'https://git.example.test/a.git', destination: target, run: run as unknown as CloneRunner }))
      .rejects.toThrow('拉取仓库失败：repository not found');
    expect(existsSync(target)).toBe(false);
  });
});
