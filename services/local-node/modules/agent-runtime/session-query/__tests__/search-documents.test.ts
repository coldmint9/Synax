import { describe, expect, it } from 'vitest';
import type { AgentRuntimeMessage } from '../../contracts.js';
import {
  MAX_INDEXED_MESSAGES,
  MAX_INDEXED_MESSAGE_CHARS,
  MAX_INDEXED_SESSION_CHARS,
  buildProjectionDocument,
  buildSessionSearchDocument,
  compactDocument,
  decodeDocument,
  encodeDocument,
  normalizeSearchText,
  segmentAt,
  sessionStamp,
} from '../search-documents.js';
import { searchMessage as message, searchSession as session } from './search-fixtures.js';

describe('normalizeSearchText', () => {
  it('folds case, width and whitespace so the query matches what is displayed', () => {
    expect(normalizeSearchText('  ＳＥＡＲＣＨ\n\t关键词  ')).toBe(
      'search 关键词',
    );
  });
});

describe('buildSessionSearchDocument', () => {
  it('indexes title, prompt and message text but never tool output', () => {
    const document = buildSessionSearchDocument(session(), [
      message('m1', 'user', '第一条消息', '2026-01-01T00:00:01.000Z'),
      message('m2', 'tool', 'grep --json 大量输出', '2026-01-01T00:00:02.000Z'),
      message('m3', 'assistant', '搜索结果已经高亮', '2026-01-01T00:00:03.000Z'),
    ]);
    expect(document.haystack).toContain('重构会话列表');
    expect(document.haystack).toContain('帮我重构会话列表');
    expect(document.haystack).toContain('搜索结果已经高亮');
    expect(document.haystack).not.toContain('grep');
    expect(document.segments.map((segment) => segment.kind)).toEqual([
      'title',
      'prompt',
      'message',
      'message',
    ]);
    expect(document.truncated).toBe(false);
    expect(segmentAt(document, document.segments[3].start + 1)?.messageId).toBe(
      'm3',
    );
  });

  it('keeps contentParts text when the plain content field is empty', () => {
    const withParts = {
      ...message('m1', 'user', '', '2026-01-01T00:00:01.000Z'),
      contentParts: [
        { type: 'text', text: '附件描述：部署脚本' },
        { type: 'image', assetId: `asset_${'a'.repeat(32)}` },
      ],
    } as AgentRuntimeMessage;
    const document = buildSessionSearchDocument(session(), [withParts]);
    // NFKC folds the full-width colon, so the query can be typed either width.
    expect(document.haystack).toContain('附件描述:部署脚本');
  });

  it('keeps the newest messages inside the budget and reports truncation', () => {
    const many = Array.from({ length: MAX_INDEXED_MESSAGES + 10 }, (_, index) =>
      message(
        `m${index}`,
        index % 2 ? 'assistant' : 'user',
        `消息 ${index}`,
        new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      ),
    );
    const document = buildSessionSearchDocument(session(), many);
    expect(document.truncated).toBe(true);
    expect(document.haystack).toContain(`消息 ${MAX_INDEXED_MESSAGES + 9}`);
    expect(document.haystack).not.toContain('消息 0');
    expect(document.chars).toBeLessThanOrEqual(
      MAX_INDEXED_SESSION_CHARS + 64,
    );
  });

  it('caps a single long message and still marks the document truncated', () => {
    const document = buildSessionSearchDocument(session(), [
      message(
        'm1',
        'user',
        '长'.repeat(MAX_INDEXED_MESSAGE_CHARS + 500),
        '2026-01-01T00:00:01.000Z',
      ),
    ]);
    expect(document.truncated).toBe(true);
    expect(document.haystack.length).toBeLessThanOrEqual(
      MAX_INDEXED_MESSAGE_CHARS + 64,
    );
  });

  it('uses the projection for title and prompt only', () => {
    const document = buildProjectionDocument(session());
    expect(document.segments.map((segment) => segment.kind)).toEqual([
      'title',
      'prompt',
    ]);
    expect(document.stamp).toBe(sessionStamp(session()));
  });
});

describe('index persistence shape', () => {
  it('round-trips through the stored arrays without losing hit offsets', () => {
    const original = buildSessionSearchDocument(session(), [
      message('m1', 'user', '部署脚本需要检查', '2026-01-01T00:00:01.000Z'),
    ]);
    const restored = decodeDocument(JSON.parse(JSON.stringify(encodeDocument(original))) as never);
    expect(restored).not.toBeNull();
    expect(restored?.haystack).toBe(original.haystack);
    expect(restored?.segments).toEqual(original.segments);
    expect(restored?.chars).toBe(original.chars);
    expect(restored?.stamp).toBe(original.stamp);
  });

  it('rejects a damaged entry instead of indexing text it cannot place', () => {
    expect(decodeDocument(undefined)).toBeNull();
    expect(
      decodeDocument({
        id: 's1',
        stamp: 'x',
        updatedAt: '2026-01-01T00:00:00.000Z',
        truncated: false,
        segments: [['unknown', null, null, null, 'text'] as never],
      }),
    ).toBeNull();
  });

  it('compacts a document down to its title and prompt', () => {
    const original = buildSessionSearchDocument(session(), [
      message('m1', 'user', '历史消息正文', '2026-01-01T00:00:01.000Z'),
    ]);
    const compacted = compactDocument(original);
    expect(compacted.haystack).not.toContain('历史消息正文');
    expect(compacted.haystack).toContain('重构会话列表');
    expect(compacted.truncated).toBe(true);
  });
});
