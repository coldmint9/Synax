import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resolveWorkspaceProjectLocation } from '../workspace-project-location.js';

let temp: string;
let main: string;
let linked: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synax-shadow-')));
  main = path.join(temp, 'main project'); linked = path.join(temp, 'outside tree');
  fs.mkdirSync(main); git(main, 'init', '-b', 'main');
  git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  git(main, 'worktree', 'add', '-b', 'feature/example', linked);
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));
const resolve = (directory: string) => resolveWorkspaceProjectLocation({ kind: 'host', path: directory });
it('redirects an external worktree and its subdirectories to the real main directory', async () => {
  fs.mkdirSync(path.join(linked, 'src'));
  for (const directory of [linked, path.join(linked, 'src')])
    expect(await resolve(directory)).toMatchObject({ redirected: true, location: { path: main }, name: 'main project' });
});
it('keeps ordinary folders and primary checkout subdirectories unchanged', async () => {
  const folder = path.join(temp, 'plain'); const sub = path.join(main, 'src');
  fs.mkdirSync(folder); fs.mkdirSync(sub);
  for (const directory of [folder, main, sub]) expect(await resolve(directory)).toMatchObject({ redirected: false, location: { path: directory } });
});
it('does not identify an independent clone as a linked worktree', async () => {
  const clone = path.join(temp, 'clone'); git(temp, 'clone', main, clone);
  expect(await resolve(clone)).toMatchObject({ redirected: false, location: { path: clone } });
});
it('normalizes symlink aliases and does not use branch names to find the primary checkout', async () => {
  git(main, 'switch', '-c', 'test');
  const alias = path.join(temp, 'alias'); fs.symlinkSync(linked, alias);
  expect(await resolve(alias)).toMatchObject({ redirected: true, location: { path: main } });
});
it('rejects an unavailable primary directory instead of registering the linked tree', async () => {
  fs.renameSync(main, path.join(temp, 'moved'));
  await expect(resolve(linked)).rejects.toThrow();
});
