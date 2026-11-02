import { describe, expect, it } from 'vitest';
import {
  buildProjectionDocument,
  buildSessionSearchDocument,
} from '../search-documents.js';
import {
  MAX_QUERY_TERMS,
  evaluateDocument,
  queryTerms,
} from '../search-evaluation.js';
import { searchMessage as message, searchSession as session } from './search-fixtures.js';

const documentWith = (text: string, createdAt = '2026-01-01T00:00:01.000Z') =>
  buildSessionSearchDocument(session({ title: null, prompt: '' }), [
    message('m1', 'user', text, createdAt),
  ]);

describe('queryTerms', () => {
  it('folds width and case, dedupes and caps the keyword list', () => {
    expect(queryTerms('  ＳＥＡＲＣＨ   search 高亮 ')).toEqual([
      'search',
      '高亮',
    ]);
    expect(queryTerms('')).toEqual([]);
    expect(queryTerms('a b c d e f g h')).toHaveLength(MAX_QUERY_TERMS);
  });
});

describe('evaluateDocument', () => {
  it('requires every keyword, so an extra word narrows the result', () => {
    const document = documentWith('部署脚本需要先检查网络');
    expect(evaluateDocument(document, ['部署'])).not.toBeNull();
    expect(evaluateDocument(document, ['部署', '网络'])).not.toBeNull();
    expect(evaluateDocument(document, ['部署', '数据库'])).toBeNull();
  });

  it('matches CJK substrings and reports the occurrences it counted', () => {
    const document = documentWith('搜索高亮：搜索框要高亮，搜索性能要好');
    const match = evaluateDocument(document, ['搜索']);
    expect(match?.kind).toBe('message');
    expect(match?.matchCount).toBe(3);
    expect(match?.snippet).toContain('搜索');
    expect(match?.messageId).toBe('m1');
  });

  it('prefers the title label and returns it as the snippet', () => {
    const document = buildSessionSearchDocument(session(), [
      message('m1', 'user', '正文也提到会话列表', '2026-01-01T00:00:01.000Z'),
    ]);
    const match = evaluateDocument(document, ['会话']);
    expect(match).toMatchObject({ kind: 'title', snippet: '重构会话列表' });
  });

  it('combines keywords that live in different parts of one session', () => {
    const document = buildSessionSearchDocument(session(), [
      message('m1', 'assistant', '部署脚本已经生成', '2026-01-01T00:00:01.000Z'),
    ]);
    // "重构" only appears in title/prompt, "部署脚本" only in the message.
    expect(evaluateDocument(document, ['重构', '部署脚本'])).not.toBeNull();
  });

  it('windows a long message around the first match with ellipses', () => {
    const document = documentWith(
      `${'前'.repeat(400)}关键词命中${'后'.repeat(400)}`,
    );
    const match = evaluateDocument(document, ['关键词命中']);
    expect(match?.snippet.startsWith('…')).toBe(true);
    expect(match?.snippet.endsWith('…')).toBe(true);
    expect(match?.snippet.length).toBeLessThan(220);
    expect(match?.snippet).toContain('关键词命中');
  });

  it('answers from a projection document without any transcript text', () => {
    const match = evaluateDocument(buildProjectionDocument(session()), ['重构']);
    expect(match).toMatchObject({ kind: 'title', messageId: null });
  });

  it('returns nothing for an empty document or no keywords', () => {
    expect(evaluateDocument(documentWith(''), ['搜索'])).toBeNull();
    expect(evaluateDocument(documentWith('搜索'), [])).toBeNull();
  });
});
