import type { WikiBlock } from '../../../../lib/contracts/wiki';

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '');
}

export function extractBlockText(block: WikiBlock): string {
  const { content, contentFormat, blockType } = block;
  if (!content) return '';

  if (contentFormat === 'markdown_fragment') {
    return typeof content === 'string' ? stripMarkdown(content) : '';
  }

  if (contentFormat === 'rich_text_json') {
    const c = content as Record<string, unknown>;
    switch (blockType) {
      case 'heading':
      case 'paragraph':
        return typeof c.text === 'string' ? c.text : '';
      case 'list':
        return Array.isArray(c.items) ? c.items.join(' ') : '';
      case 'table': {
        const headers = Array.isArray(c.headers) ? c.headers.join(' ') : '';
        const rows = Array.isArray(c.rows)
          ? (c.rows as string[][]).flat().join(' ')
          : '';
        return `${headers} ${rows}`.trim();
      }
      case 'code_ref':
        return [c.filePath, c.symbol, c.code].filter(Boolean).join(' ');
      case 'decision':
        return [c.title, c.decision, c.rationale].filter(Boolean).join(' ');
      case 'risk':
        return [c.title, c.description, c.mitigation].filter(Boolean).join(' ');
      case 'task':
        return [c.title, c.description].filter(Boolean).join(' ');
      case 'diagram':
        return typeof c.title === 'string' ? c.title : '';
      default:
        return typeof c.text === 'string' ? c.text : '';
    }
  }

  return '';
}

export interface MatchSnippet {
  before: string;
  match: string;
  after: string;
}

export function highlightMatch(text: string, query: string, contextChars = 60): MatchSnippet | null {
  if (!query) return null;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return null;

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + query.length + contextChars);

  return {
    before: (start > 0 ? '…' : '') + text.slice(start, idx),
    match: text.slice(idx, idx + query.length),
    after: text.slice(idx + query.length, end) + (end < text.length ? '…' : ''),
  };
}

export function getSnippet(text: string, query: string, contextChars = 80): string {
  const m = highlightMatch(text, query, contextChars);
  if (!m) return text.slice(0, contextChars * 2);
  return `${m.before}${m.match}${m.after}`;
}
