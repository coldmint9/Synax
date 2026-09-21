import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { resolveDesktopPath } from './desktop-path.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const options = { platform: 'darwin' as const, home: '/home/test', shell: '/bin/zsh' };
it('preserves an inherited version-manager PATH ahead of fallback binaries', async () => {
  vi.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as any);
  vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    callback(null, '\0/other/node/bin:/usr/bin\0', '');
  }) as any);
  expect((await resolveDesktopPath('/fnm/node/bin:/usr/bin', options)).split(':').slice(0, 3))
    .toEqual(['/fnm/node/bin', '/usr/bin', '/other/node/bin']);
});
it('recovers GUI shell PATH before using Homebrew fallbacks and ignores startup chatter', async () => {
  vi.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as any);
  vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    callback(null, 'startup message\n\0/fnm/node/bin:/usr/bin\0\n', '');
  }) as any);
  const result = (await resolveDesktopPath('/usr/bin:/bin', options)).split(':');
  expect(result.indexOf('/fnm/node/bin')).toBeLessThan(result.indexOf('/opt/homebrew/bin'));
  expect(result.filter(p => p === '/usr/bin')).toHaveLength(1);
  expect(result).not.toContain('startup message');
  expect(execFile).toHaveBeenCalledWith('/bin/zsh', expect.any(Array), expect.objectContaining({ timeout: 3000, cwd: '/home/test' }), expect.any(Function));
});
it('falls back without blocking startup if the login shell fails', async () => {
  vi.spyOn(fs, 'statSync').mockImplementation(((p: string) => {
    if (p === '/opt/homebrew/bin') return { isDirectory: () => true };
    throw new Error('missing');
  }) as any);
  vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, callback: Function) => callback(new Error('timeout'))) as any);
  expect(await resolveDesktopPath('/usr/bin', options)).toBe('/usr/bin:/opt/homebrew/bin');
});
it('does not invoke a POSIX shell or rewrite PATH on Windows', async () => {
  vi.mocked(execFile).mockClear();
  expect(await resolveDesktopPath('C:\\Node;C:\\Windows', { ...options, platform: 'win32' })).toBe('C:\\Node;C:\\Windows');
  expect(execFile).not.toHaveBeenCalled();
});
