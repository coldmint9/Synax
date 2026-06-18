const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

export function normalizeHeadingText(text: string): string {
  return text.replace(/^#+\s*/, '').trim().toLowerCase();
}

export interface ExtractedMarkdownSection {
  found: boolean;
  heading: string;
  level: number;
  contentMd: string;
  startLine: number | null;
  endLine: number | null;
}

function findHeadingLine(
  lines: string[],
  normalizedQuery: string,
  mode: 'exact' | 'partial',
): { index: number; level: number; title: string } | null {
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADING_RE);
    if (!match) continue;
    const title = match[2].trim();
    const normalizedTitle = normalizeHeadingText(title);
    const matched =
      mode === 'exact'
        ? normalizedTitle === normalizedQuery
        : normalizedTitle.includes(normalizedQuery);
    if (matched) {
      return { index: i, level: match[1].length, title };
    }
  }
  return null;
}

export function extractMarkdownSection(
  contentMd: string,
  headingQuery: string,
  opts?: { maxChars?: number },
): ExtractedMarkdownSection {
  const normalizedQuery = normalizeHeadingText(headingQuery);
  if (!normalizedQuery) {
    return {
      found: false,
      heading: headingQuery,
      level: 0,
      contentMd: '',
      startLine: null,
      endLine: null,
    };
  }

  const lines = contentMd.split(/\r?\n/);
  const hit =
    findHeadingLine(lines, normalizedQuery, 'exact') ??
    findHeadingLine(lines, normalizedQuery, 'partial');

  if (!hit) {
    return {
      found: false,
      heading: headingQuery,
      level: 0,
      contentMd: '',
      startLine: null,
      endLine: null,
    };
  }

  let endIdx = lines.length;
  for (let i = hit.index + 1; i < lines.length; i++) {
    const match = lines[i].match(HEADING_RE);
    if (match && match[1].length <= hit.level) {
      endIdx = i;
      break;
    }
  }

  let sectionContent = lines.slice(hit.index, endIdx).join('\n');
  const maxChars = opts?.maxChars;
  if (maxChars && sectionContent.length > maxChars) {
    sectionContent = `${sectionContent.slice(0, maxChars)}\n\n…(truncated)`;
  }

  return {
    found: true,
    heading: hit.title,
    level: hit.level,
    contentMd: sectionContent,
    startLine: hit.index + 1,
    endLine: endIdx,
  };
}
