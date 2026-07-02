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
