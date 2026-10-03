import { describe, expect, it } from 'vitest';
import { parseSkillMarkdown, parseSkillFile } from '../skill-parser.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-skill', 'SKILL.md');

describe('skill-parser', () => {
  it('parses frontmatter and body', () => {
    const raw = `---
name: demo-skill
description: Demo skill for tests
version: 1.0.0
synax:
  applies-to: [explorer]
---

# Demo

Do the thing.
`;
    const parsed = parseSkillMarkdown(raw);
    expect(parsed.frontmatter.name).toBe('demo-skill');
    expect(parsed.body).toContain('# Demo');
  });

  it('loads a fixture SKILL.md file', () => {
    const parsed = parseSkillFile(FIXTURE);
    expect(parsed.name).toBe('demo-skill');
    expect(parsed.description).toContain('Demo skill');
    expect(parsed.appliesTo).toEqual(['explorer']);
    expect(parsed.content).toContain('Do the thing');
  });
});

describe('parseSkillFile — profile-ids and injection', () => {
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'deterministic-skill',
    'SKILL.md',
  );

  it('parses profile-ids into profileIds', () => {
    const parsed = parseSkillFile(fixture);
    expect(parsed.profileIds).toEqual(['wiki-document-writer']);
  });

  it('parses injection mode', () => {
    const parsed = parseSkillFile(fixture);
    expect(parsed.injection).toBe('deterministic');
  });

  it('keeps applies-to alongside profile-ids', () => {
    const parsed = parseSkillFile(fixture);
    expect(parsed.appliesTo).toEqual(['executor']);
  });

  it('defaults profileIds to [] and injection to on-demand', () => {
    const raw = [
      '---',
      'name: plain-skill',
      'description: No synax block at all.',
      '---',
      '',
      '# Plain',
    ].join('\n');
    const { frontmatter } = parseSkillMarkdown(raw);
    expect(frontmatter.synax).toBeUndefined();

    const builtin = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'skills',
      'builtin',
      'synax-explore',
      'SKILL.md',
    );
    const parsed = parseSkillFile(builtin);
    expect(parsed.profileIds).toEqual([]);
    expect(parsed.injection).toBe('on-demand');
  });
});
