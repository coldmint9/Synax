import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWikiAuthoringGuide } from '../wiki-authoring-skill.js';
import { WIKI_AUTHORING_BUILTIN_BODY } from '../generated/wiki-authoring-builtin.js';

const tempDirs: string[] = [];

function makeWorkDir(skillBody?: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wiki-authoring-'));
  tempDirs.push(dir);
  if (skillBody !== undefined) {
    const skillDir = path.join(dir, '.synax', 'skills', 'wiki-authoring');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), skillBody, 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('resolveWikiAuthoringGuide', () => {
  it('falls back to the inlined baseline when no override exists', () => {
    const guide = resolveWikiAuthoringGuide({ workDir: makeWorkDir() });
    expect(guide.origin).toBe('builtin');
    expect(guide.body).toBe(WIKI_AUTHORING_BUILTIN_BODY);
  });

  it('falls back to the baseline when workDir is absent', () => {
    expect(resolveWikiAuthoringGuide().origin).toBe('builtin');
    expect(resolveWikiAuthoringGuide({ workDir: null }).origin).toBe('builtin');
  });

  it('prefers a project override and strips its frontmatter', () => {
    const workDir = makeWorkDir([
      '---',
      'name: wiki-authoring',
      'description: Project override.',
      '---',
      '',
      '# Project Rules',
      '',
      'Write in haiku.',
    ].join('\n'));

    const guide = resolveWikiAuthoringGuide({ workDir });
    expect(guide.origin).toBe('project');
    expect(guide.body).toContain('Write in haiku.');
    expect(guide.body.startsWith('---')).toBe(false);
  });

  it('accepts an override with no frontmatter', () => {
    const workDir = makeWorkDir('# Bare Override\n\nNo frontmatter here.');
    const guide = resolveWikiAuthoringGuide({ workDir });
    expect(guide.origin).toBe('project');
    expect(guide.body).toContain('No frontmatter here.');
  });

  it('ignores an override whose body is empty', () => {
    const workDir = makeWorkDir([
      '---',
      'name: wiki-authoring',
      'description: Empty body.',
      '---',
      '',
      '   ',
    ].join('\n'));

    const guide = resolveWikiAuthoringGuide({ workDir });
    expect(guide.origin).toBe('builtin');
  });
});
