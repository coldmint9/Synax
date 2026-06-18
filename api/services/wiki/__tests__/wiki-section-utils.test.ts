import { describe, expect, it } from 'vitest';
import { extractMarkdownSection, normalizeHeadingText } from '../tools/section-utils.js';

describe('section-utils', () => {
  const sample = `# Overview

Intro paragraph.

## Authentication

Auth overview text.

### Token refresh

Refresh details here.

## Data Model

Schema notes.
`;

  it('normalizeHeadingText strips markdown heading markers', () => {
    expect(normalizeHeadingText('## Authentication')).toBe('authentication');
  });

  it('extractMarkdownSection returns section with subsections', () => {
    const section = extractMarkdownSection(sample, 'Authentication');
    expect(section.found).toBe(true);
    expect(section.heading).toBe('Authentication');
    expect(section.level).toBe(2);
    expect(section.contentMd).toContain('Token refresh');
    expect(section.contentMd).not.toContain('Data Model');
    expect(section.startLine).toBe(5);
  });

  it('extractMarkdownSection supports partial heading match', () => {
    const section = extractMarkdownSection(sample, 'token');
    expect(section.found).toBe(true);
    expect(section.heading).toBe('Token refresh');
    expect(section.contentMd).not.toContain('Auth overview');
  });

  it('extractMarkdownSection returns not found for missing heading', () => {
    const section = extractMarkdownSection(sample, 'Missing Section');
    expect(section.found).toBe(false);
    expect(section.contentMd).toBe('');
  });
});
