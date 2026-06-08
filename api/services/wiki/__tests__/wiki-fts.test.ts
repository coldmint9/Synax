import { describe, it, expect } from 'vitest';
import { extractSearchText, cjkSeparate } from '../wiki-fts.js';
import type { WikiBlockType } from '../contracts.js';

describe('cjkSeparate', () => {
  it('spaces around CJK characters', () => {
    expect(cjkSeparate('用户认证')).toBe('用 户 认 证');
  });

  it('leaves ASCII words intact', () => {
    expect(cjkSeparate('hello world')).toBe('hello world');
  });

  it('handles mixed text', () => {
    const result = cjkSeparate('UserService 用户认证模块 handles JWT');
    expect(result).toBe('UserService 用 户 认 证 模 块 handles JWT');
  });

  it('collapses multiple spaces', () => {
    expect(cjkSeparate('用  户')).toBe('用 户');
  });
});

describe('extractSearchText', () => {
  it('extracts and CJK-separates heading content', () => {
    const result = extractSearchText('heading', 'structured_json', { level: 1, text: '用户认证模块' });
    expect(result).toBe('用 户 认 证 模 块');
  });

  it('extracts and CJK-separates prose with segments', () => {
    const content = {
      segments: [
        { type: 'text', value: '这是一个' },
        { type: 'bold', value: '重要' },
        { type: 'text', value: '的模块。' },
        { type: 'code', value: 'UserService' },
      ],
    };
    const result = extractSearchText('prose', 'structured_json', content);
    expect(result).toBe('这 是 一 个 重 要 的 模 块 。UserService');
  });

  it('extracts text from signature tokens', () => {
    const content = {
      language: 'typescript',
      tokens: [
        { type: 'keyword', value: 'export' },
        { type: 'punctuation', value: ' ' },
        { type: 'keyword', value: 'function' },
        { type: 'punctuation', value: ' ' },
        { type: 'name', value: 'authenticate' },
        { type: 'punctuation', value: '(' },
        { type: 'param', value: 'token' },
        { type: 'punctuation', value: ': ' },
        { type: 'type', value: 'string' },
        { type: 'punctuation', value: ')' },
      ],
      source: { file: 'auth.ts', line: 10 },
    };
    const result = extractSearchText('signature', 'structured_json', content);
    expect(result).toBe('export function authenticate(token: string)');
  });

  it('extracts and CJK-separates callout', () => {
    const content = {
      level: 'warn',
      title: '注意事项',
      body: [
        { type: 'text', value: '请确保 token 有效。' },
      ],
    };
    const result = extractSearchText('callout', 'structured_json', content);
    expect(result).toBe('注 意 事 项 请 确 保 token 有 效 。');
  });

  it('extracts text from list with nested items', () => {
    const content = {
      ordered: false,
      items: [
        {
          segments: [{ type: 'text', value: '第一项' }],
          children: [
            { segments: [{ type: 'text', value: '子项' }] },
          ],
        },
        { segments: [{ type: 'text', value: '第二项' }] },
      ],
    };
    const result = extractSearchText('list', 'structured_json', content);
    expect(result).toContain('第 一 项');
    expect(result).toContain('子 项');
    expect(result).toContain('第 二 项');
  });

  it('extracts text from table', () => {
    const content = {
      headers: [
        { key: 'name', label: '名称' },
        { key: 'type', label: '类型' },
      ],
      rows: [
        { name: 'userId', type: 'string' },
        { name: 'token', type: { type: 'code', value: 'JWT' } },
      ],
    };
    const result = extractSearchText('table', 'structured_json', content);
    expect(result).toContain('名 称');
    expect(result).toContain('类 型');
    expect(result).toContain('userId');
    expect(result).toContain('JWT');
  });

  it('extracts caption from diagram', () => {
    const content = {
      diagramType: 'flowchart',
      code: 'graph TD...',
      caption: '认证流程图',
    };
    const result = extractSearchText('diagram', 'structured_json', content);
    expect(result).toBe('认 证 流 程 图');
  });

  it('strips markdown and CJK-separates for markdown_fragment format', () => {
    const markdown = '## 标题\n\n这是 **粗体** 和 `代码` 以及 [链接](url)';
    const result = extractSearchText('prose', 'markdown_fragment', markdown);
    expect(result).toContain('标 题');
    expect(result).toContain('粗 体');
    expect(result).toContain('代 码');
    expect(result).toContain('链 接');
    expect(result).not.toContain('**');
    expect(result).not.toContain('`');
    expect(result).not.toContain('[');
  });

  it('returns empty string for null content', () => {
    const result = extractSearchText('prose', 'structured_json', null);
    expect(result).toBe('');
  });

  it('extracts xref labels from segments', () => {
    const content = {
      segments: [
        { type: 'text', value: '参见 ' },
        { type: 'xref', target: 'auth-module', label: '认证模块' },
      ],
    };
    const result = extractSearchText('prose', 'structured_json', content);
    expect(result).toBe('参 见 认 证 模 块');
  });

  it('handles prose with text field (simplified schema)', () => {
    const content = { text: '这是一个简化版本的 prose 内容。' };
    const result = extractSearchText('prose', 'structured_json', content);
    expect(result).toBe('这 是 一 个 简 化 版 本 的 prose 内 容 。');
  });

  it('handles list with string items (simplified schema)', () => {
    const content = { items: ['第一项', '第二项', '第三项'], ordered: false };
    const result = extractSearchText('list', 'structured_json', content);
    expect(result).toContain('第 一 项');
    expect(result).toContain('第 二 项');
    expect(result).toContain('第 三 项');
  });

  it('handles markdown_fragment with object content (legacy mislabel)', () => {
    // Some blocks are labeled markdown_fragment but actually contain structured JSON objects
    const content = { level: 2, text: '分层架构' };
    const result = extractSearchText('heading', 'markdown_fragment', content);
    expect(result).toBe('分 层 架 构');
  });

  it('handles markdown_fragment with prose segments object', () => {
    const content = {
      segments: [
        { type: 'text', value: '这是一段' },
        { type: 'bold', value: '重要' },
        { type: 'text', value: '内容。' },
      ],
    };
    const result = extractSearchText('prose', 'markdown_fragment', content);
    expect(result).toBe('这 是 一 段 重 要 内 容 。');
  });

  it('handles empty diagram_json gracefully', () => {
    const result = extractSearchText('diagram', 'diagram_json', {});
    expect(result).toBe('');
  });

  it('handles diagram with code but no caption', () => {
    const content = { diagramType: 'flowchart', code: 'graph TD; A[开始] --> B[结束];' };
    const result = extractSearchText('diagram', 'structured_json', content);
    // Should extract text from diagram code (labels, etc.)
    expect(result).toBeTruthy();
    expect(result).toContain('开 始');
    expect(result).toContain('结 束');
  });

  it('handles prose with only text field (no segments)', () => {
    const content = { text: '纯文本 prose 内容' };
    const result = extractSearchText('prose', 'structured_json', content);
    expect(result).toBe('纯 文 本 prose 内 容');
  });

  it('handles heading via markdown_fragment mislabel', () => {
    const content = { level: 1, text: '项目定位', anchor: 'project-positioning' };
    const result = extractSearchText('heading', 'markdown_fragment', content);
    expect(result).toBe('项 目 定 位');
  });

  it('handles table via markdown_fragment mislabel', () => {
    const content = {
      headers: [{ key: 'layer', label: '层次' }],
      rows: [{ layer: '运行时' }],
    };
    const result = extractSearchText('table', 'markdown_fragment', content);
    expect(result).toContain('层 次');
    expect(result).toContain('运 行 时');
  });
});
