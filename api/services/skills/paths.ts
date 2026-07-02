import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { DATA_ROOT } from '../../lib/env.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function resolveBuiltinSkillsRoot(): string {
  return path.join(MODULE_DIR, '..', '..', 'skills', 'builtin');
}

export function resolveGlobalSkillsRoot(): string {
  return path.join(DATA_ROOT, 'skills');
}

export function resolveProjectSkillsRoot(projectId: string, workDir?: string | null): string | null {
  if (workDir) {
    return path.join(workDir, '.synax', 'skills');
  }
  if (!projectId) return null;
  return null;
}

export function expandHome(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}
