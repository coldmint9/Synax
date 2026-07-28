import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  renderWikiAuthoringBundle,
  WIKI_AUTHORING_BUNDLE_PATH,
  WIKI_AUTHORING_SKILL_PATH,
} from '../wiki-authoring-codegen.js';
import {
  WIKI_AUTHORING_BUILTIN_BODY,
  WIKI_AUTHORING_BUILTIN_VERSION,
} from '../generated/wiki-authoring-builtin.js';

describe('wiki-authoring generated bundle', () => {
  it('matches the committed artifact (run: npx tsx scripts/generate-wiki-skill-bundle.ts)', () => {
    const raw = readFileSync(WIKI_AUTHORING_SKILL_PATH, 'utf8');
    const expected = renderWikiAuthoringBundle(raw);
    const actual = readFileSync(WIKI_AUTHORING_BUNDLE_PATH, 'utf8');
    expect(actual).toBe(expected);
  });

  it('exports a non-trivial body', () => {
    expect(WIKI_AUTHORING_BUILTIN_BODY.length).toBeGreaterThan(2000);
  });

  it('carries the frontmatter version', () => {
    expect(WIKI_AUTHORING_BUILTIN_VERSION).toBe('1.0.0');
  });

  it('strips frontmatter from the body', () => {
    expect(WIKI_AUTHORING_BUILTIN_BODY.startsWith('---')).toBe(false);
    expect(WIKI_AUTHORING_BUILTIN_BODY).not.toContain('injection: deterministic');
  });

  it('keeps the reader contract in the body', () => {
    expect(WIKI_AUTHORING_BUILTIN_BODY).toContain('Reader contract');
    expect(WIKI_AUTHORING_BUILTIN_BODY).toContain('Pre-submit checklist');
  });
});
