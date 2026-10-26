import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { canonicalizeWorkspaceLocation, workspaceLocationHostPath, type WorkspaceLocation } from './workspace-location.js';
import { decodeWslOutput, wslCommandSpec } from '../infrastructure/wsl/wsl.js';

const exec = promisify(execFile);
export interface WorkspacePathResolution {
  inputLocation: WorkspaceLocation;
  location: WorkspaceLocation;
  name: string;
  redirected: boolean;
  duplicate?: boolean;
}

async function git(location: WorkspaceLocation, args: string[]): Promise<string> {
  const spec = location.kind === 'wsl'
    ? wslCommandSpec(location.distribution, location.path, 'git', args)
    : { command: 'git', args };
  const result = await exec(spec.command, spec.args, {
    ...(location.kind === 'host' ? { cwd: location.path } : {}),
    encoding: 'buffer', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    windowsHide: true, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
  });
  return location.kind === 'wsl' ? decodeWslOutput(result.stdout) : result.stdout.toString('utf8');
}

/** Normalize linked worktrees only. Ordinary folders, submodules and primary
 * checkout subdirectories retain their existing workspace semantics. */
export async function resolveWorkspaceProjectLocation(input: WorkspaceLocation): Promise<WorkspacePathResolution> {
  const inputLocation = await canonicalizeWorkspaceLocation(input);
  const api = inputLocation.kind === 'wsl' ? path.posix : path;
  let metadata: string;
  try {
    metadata = await git(inputLocation, ['rev-parse', '--path-format=absolute', '--is-bare-repository', '--git-dir', '--git-common-dir']);
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? '');
    if (!/not a git repository/i.test(stderr)) throw error;
    // A broken .git pointer is an unavailable repository, not an ordinary folder.
    let directory = workspaceLocationHostPath(inputLocation);
    for (;;) {
      if (await access(path.join(directory, '.git')).then(() => true, () => false)) throw error;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return { inputLocation, location: inputLocation, name: api.basename(inputLocation.path), redirected: false };
  }
  const [bare, gitDir, commonDir] = metadata.trimEnd().split('\n');
  if (bare === 'true') throw new Error('请选择具有主工作目录的仓库；裸仓库不能作为工作区项目。');
  if (!gitDir || !commonDir) throw new Error('无法确认项目的 Git 工作目录。');
  if (api.normalize(gitDir) === api.normalize(commonDir))
    return { inputLocation, location: inputLocation, name: api.basename(inputLocation.path), redirected: false };
  // Git lists the primary checkout first. Use porcelain NUL fields so spaces,
  // tabs and quoted paths cannot redirect us to a different directory.
  const fields = (await git(inputLocation, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0')[0].split('\0');
  const mainPath = fields.find(field => field.startsWith('worktree '))?.slice(9);
  if (!mainPath || fields.includes('bare')) throw new Error('该工作树没有可用的主目录，请先修复仓库。');
  const location = await canonicalizeWorkspaceLocation({ ...inputLocation, path: mainPath });
  return { inputLocation, location, name: api.basename(location.path), redirected: true };
}
