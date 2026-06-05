import { describe, it, expect } from 'vitest';
import { extractBlockText, highlightMatch, getSnippet } from '../wikiSearchUtils';
import type { WikiBlock } from '../../../../../lib/contracts/wiki';

function makeBlock(overrides: Partial<WikiBlock>): WikiBlock {
  return {
    id: 'block-1',
    projectId: 'proj-1',
    documentId: 'doc-1',
    blockType: 'prose',
    content: null,
    contentFormat: 'structured_json',
    sourceBindingIds: [],
    contentHash: 'abc',
    generatedFromHash: null,
    staleState: 'fresh',
    manualState: 'none',
    confidence: 0.9,
    generatedBy: {},
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('extractBlockText', () => {
  it('extracts text from markdown_fragment blocks', () => {
    const block = makeBlock({
      contentFormat: 'markdown_fragment',
      content: '## Hello **world**',
    });
    expect(extractBlockText(block)).toBe('Hello world');
  });

  it('extracts text from heading blocks', () => {
    const block = makeBlock({
      blockType: 'heading',
      content: { level: 1, text: 'Architecture Overview', anchor: 'arch' },
    });
    expect(extractBlockText(block)).toBe('Architecture Overview');
  });

  it('extracts text from prose blocks with segments', () => {
    const block = makeBlock({
      blockType: 'prose',
      content: {
        segments: [
          { type: 'text', value: 'The ' },
          { type: 'bold', value: 'UserService' },
          { type: 'text', value: ' handles authentication via ' },
          { type: 'code', value: 'JWT' },
        ],
      },
    });
    expect(extractBlockText(block)).toBe('The UserService handles authentication via JWT');
  });

  it('extracts text from signature blocks', () => {
    const block = makeBlock({
      blockType: 'signature',
      content: {
        language: 'typescript',
        tokens: [
          { type: 'keyword', value: 'export' },
          { type: 'punctuation', value: ' ' },
          { type: 'keyword', value: 'function' },
          { type: 'punctuation', value: ' ' },
          { type: 'name', value: 'createUser' },
          { type: 'punctuation', value: '(' },
          { type: 'param', value: 'name' },
          { type: 'punctuation', value: ': ' },
          { type: 'type', value: 'string' },
          { type: 'punctuation', value: ')' },
        ],
        source: { file: 'user.ts', line: 10 },
      },
    });
    expect(extractBlockText(block)).toContain('createUser');
    expect(extractBlockText(block)).toContain('string');
  });

  it('extracts text from callout blocks', () => {
    const block = makeBlock({
      blockType: 'callout',
      content: {
        level: 'warn',
        title: 'Deprecation Notice',
        body: [
          { type: 'text', value: 'This API will be removed in v3.' },
        ],
      },
    });
    const text = extractBlockText(block);
    expect(text).toContain('Deprecation Notice');
    expect(text).toContain('This API will be removed in v3.');
  });

  it('extracts text from list blocks', () => {
    const block = makeBlock({
      blockType: 'list',
      content: {
        ordered: false,
        items: [
          { segments: [{ type: 'text', value: 'First item' }] },
          { segments: [{ type: 'text', value: 'Second item' }], children: [
            { segments: [{ type: 'text', value: 'Nested' }] },
          ]},
        ],
      },
    });
    const text = extractBlockText(block);
    expect(text).toContain('First item');
    expect(text).toContain('Second item');
    expect(text).toContain('Nested');
  });

  it('extracts text from table blocks', () => {
    const block = makeBlock({
      blockType: 'table',
      content: {
        headers: [{ key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }],
        rows: [{ name: 'id', type: 'number' }, { name: 'email', type: 'string' }],
      },
    });
    const text = extractBlockText(block);
    expect(text).toContain('Name');
    expect(text).toContain('Type');
    expect(text).toContain('email');
    expect(text).toContain('string');
  });

  it('extracts text from diagram blocks', () => {
    const block = makeBlock({
      blockType: 'diagram',
      content: {
        diagramType: 'flowchart',
        code: 'A --> B --> C',
        caption: 'Request flow',
      },
    });
    expect(extractBlockText(block)).toBe('Request flow');
  });

  it('returns empty for null content', () => {
    const block = makeBlock({ content: null });
    expect(extractBlockText(block)).toBe('');
  });

  it('returns empty for unknown contentFormat', () => {
    const block = makeBlock({ contentFormat: 'rich_text_json' as never, content: { text: 'nope' } });
    expect(extractBlockText(block)).toBe('');
  });
});

describe('highlightMatch', () => {
  it('returns match with context', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const result = highlightMatch(text, 'fox', 10);
    expect(result).not.toBeNull();
    expect(result!.match).toBe('fox');
    expect(result!.before).toContain('brown');
    expect(result!.after).toContain('jumps');
  });

  it('returns null for no match', () => {
    expect(highlightMatch('hello world', 'xyz')).toBeNull();
  });

  it('is case-insensitive', () => {
    const result = highlightMatch('Hello World', 'hello');
    expect(result).not.toBeNull();
    expect(result!.match).toBe('Hello');
  });
});

describe('getSnippet', () => {
  it('returns a context snippet for a match', () => {
    const text = 'The authentication module uses JWT tokens for session management.';
    const snippet = getSnippet(text, 'JWT');
    expect(snippet).toContain('JWT');
  });

  it('returns prefix for no match', () => {
    const text = 'Some long text that does not contain the query';
    const snippet = getSnippet(text, 'zzz', 10);
    expect(snippet).toBe('Some long text that ');
  });
});
