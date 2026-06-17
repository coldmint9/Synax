import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadMergedProjectInstructions,
  loadProjectInstructions,
} from '../synax-instructions.js';
import { buildSynaxMdContent, ensureSynaxMd } from '../synax-md.js';

const tempDirs: string[] = [];

function makeTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-md-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(dir, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('synax instructions loader', () => {
  it('loads SYNAX.md and merges local overrides', () => {
    const dir = makeTempProject({
      'SYNAX.md': '# Project\n\n## Team notes\n\n- manual rule',
      'SYNAX.local.md': 'Use pnpm locally.',
    });

    const loaded = loadProjectInstructions(dir);
    expect(loaded?.sourceFile).toBe('SYNAX.md');
    expect(loaded?.body).toContain('manual rule');

    const merged = loadMergedProjectInstructions(dir);
    expect(merged).toContain('Local Overrides');
    expect(merged).toContain('Use pnpm locally.');
  });

  it('falls back to AGENTS.md when SYNAX.md is missing', () => {
    const dir = makeTempProject({
      'AGENTS.md': '# Agents\n\nRun `npm test`.',
    });
    const loaded = loadProjectInstructions(dir);
    expect(loaded?.sourceFile).toBe('AGENTS.md');
  });
});

describe('synax-md', () => {
  it('creates SYNAX.md with commands from package.json', () => {
    const dir = makeTempProject({
      'package.json': JSON.stringify({
        name: 'demo-app',
        scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
      }),
    });

    const result = ensureSynaxMd({ workDir: dir, projectId: 'p1' });
    expect(result.created).toBe(true);

    const raw = fs.readFileSync(path.join(dir, 'SYNAX.md'), 'utf8');
    expect(raw).toContain('demo-app');
    expect(raw).toContain('npm run test');
    expect(raw).toContain('## Team notes');
  });

  it('preserves team notes on refresh', () => {
    const dir = makeTempProject({
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }),
    });
    const withNote = buildSynaxMdContent({ workDir: dir, projectId: 'p1' }).replace(
      '## Team notes\n\n_Add conventions',
      '## Team notes\n\n- never commit .env',
    );
    fs.writeFileSync(path.join(dir, 'SYNAX.md'), withNote, 'utf8');

    ensureSynaxMd({ workDir: dir, projectId: 'p1' });

    const raw = fs.readFileSync(path.join(dir, 'SYNAX.md'), 'utf8');
    expect(raw).toContain('never commit .env');
    expect(raw).toContain('npm run test');
  });
});
