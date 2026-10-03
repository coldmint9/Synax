import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listDirectories } from '../fs.js';

// Fixture layout:
//   <root>/alpha/            plain directory
//   <root>/node_modules/     ignored by default
//   <root>/.hidden/          hidden by default
//   <root>/afile.txt         not a directory
//   <root>/asymlink -> alpha directory symlink
//   <root>/abroken -> missing target
let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-fs-'));
  fs.mkdirSync(path.join(root, 'alpha'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'afile.txt'), 'not a directory');
  fs.symlinkSync(path.join(root, 'alpha'), path.join(root, 'asymlink'));
  fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, 'abroken'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const names = async (dir: string, options?: { showHidden?: boolean; showIgnored?: boolean }) =>
  (await listDirectories(dir, options)).entries.map(entry => entry.name);

describe('listDirectories', () => {
  it('returns only navigable child directories, hiding dotfiles and ignored build dirs', async () => {
    expect(await names(root)).toEqual(['alpha', 'asymlink']);
  });

  it('includes hidden and ignored directories when explicitly requested', async () => {
    expect(await names(root, { showHidden: true, showIgnored: true })).toEqual([
      '.hidden',
      'alpha',
      'asymlink',
      'node_modules',
    ]);
  });

  it('reports canonical path, parent and shortcuts so the client can navigate upward', async () => {
    const listing = await listDirectories(path.join(root, 'alpha'));
    expect(listing.path).toBe(fs.realpathSync(path.join(root, 'alpha')));
    expect(listing.name).toBe('alpha');
    expect(listing.parent).toBe(fs.realpathSync(root));
    expect(listing.home).toBe(os.homedir());
    expect(listing.truncated).toBe(false);
    expect(listing.shortcuts.every(shortcut => path.isAbsolute(shortcut))).toBe(true);
    expect(listing.shortcuts).not.toContain(listing.path);
  });

  it('defaults to the home directory when no path is given', async () => {
    const listing = await listDirectories();
    expect(listing.path).toBe(fs.realpathSync(os.homedir()));
  });

  it('rejects relative paths, files and missing directories', async () => {
    await expect(listDirectories('relative/path')).rejects.toThrow(/absolute/i);
    await expect(listDirectories(path.join(root, 'afile.txt'))).rejects.toThrow(/not a directory/i);
    await expect(listDirectories(path.join(root, 'does-not-exist'))).rejects.toThrow(/not found/i);
  });
});
