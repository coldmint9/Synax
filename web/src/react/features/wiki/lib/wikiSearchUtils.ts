import type { WikiBlock, Segment, ListItem } from '../../../../lib/contracts/wiki';

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

function segmentsToText(segments: Segment[]): string {
  return segments.map(s => 'value' in s ? s.value : s.label).join('');
}

function listItemsToText(items: ListItem[]): string {
  return items.map(item => {
    const text = segmentsToText(item.segments);
    const childText = item.children ? listItemsToText(item.children) : '';
    return childText ? `${text} ${childText}` : text;
  }).join(' ');
}

export function extractBlockText(block: WikiBlock): string {
  const { content, contentFormat, blockType } = block;
  if (!content) return '';

  if (contentFormat === 'markdown_fragment') {
    return typeof content === 'string' ? stripMarkdown(content) : '';
  }

  if (contentFormat === 'structured_json') {
    const c = content as Record<string, unknown>;
    switch (blockType) {
      case 'heading':
        return typeof c.text === 'string' ? c.text : '';
      case 'prose':
        return Array.isArray(c.segments) ? segmentsToText(c.segments as Segment[]) : '';
      case 'signature': {
        const tokens = Array.isArray(c.tokens) ? c.tokens as Array<{ value: string }> : [];
        return tokens.map(t => t.value).join('');
      }
      case 'callout': {
        const title = typeof c.title === 'string' ? c.title : '';
        const body = Array.isArray(c.body) ? segmentsToText(c.body as Segment[]) : '';
        return `${title} ${body}`.trim();
      }
      case 'list':
        return Array.isArray(c.items) ? listItemsToText(c.items as ListItem[]) : '';
      case 'table': {
        const headers = Array.isArray(c.headers)
          ? (c.headers as Array<{ label: string }>).map(h => h.label).join(' ')
          : '';
        const rows = Array.isArray(c.rows)
          ? (c.rows as Array<Record<string, string | { type: string; value: string }>>)
              .flatMap(row => Object.values(row).map(v => typeof v === 'string' ? v : v.value))
              .join(' ')
          : '';
        return `${headers} ${rows}`.trim();
      }
      case 'diagram': {
        const caption = typeof c.caption === 'string' ? c.caption : '';
        const code = typeof c.code === 'string' ? c.code : '';
        return caption || code;
      }
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
