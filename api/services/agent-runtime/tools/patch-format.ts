// Adapted from /Users/mint/opencode/packages/opencode/src/patch/index.ts
// so the local runtime can accept the same apply_patch-style envelope.

export interface UpdateFileChunk {
  oldLines: string[];
  newLines: string[];
  changeContext?: string;
  isEndOfFile?: boolean;
}

export type PatchHunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; chunks: UpdateFileChunk[] };

function parsePatchHeader(
  lines: string[],
  startIndex: number,
): { path: string; movePath?: string; nextIndex: number; kind: 'add' | 'delete' | 'update' } | null {
  const line = lines[startIndex];
  if (line.startsWith('*** Add File:')) {
    const filePath = line.slice('*** Add File:'.length).trim();
    return filePath ? { kind: 'add', path: filePath, nextIndex: startIndex + 1 } : null;
  }
  if (line.startsWith('*** Delete File:')) {
    const filePath = line.slice('*** Delete File:'.length).trim();
    return filePath ? { kind: 'delete', path: filePath, nextIndex: startIndex + 1 } : null;
  }
  if (line.startsWith('*** Update File:')) {
    const filePath = line.slice('*** Update File:'.length).trim();
    let movePath: string | undefined;
    let nextIndex = startIndex + 1;
    if (nextIndex < lines.length && lines[nextIndex].startsWith('*** Move to:')) {
      movePath = lines[nextIndex].slice('*** Move to:'.length).trim();
      nextIndex += 1;
    }
    return filePath ? { kind: 'update', path: filePath, movePath, nextIndex } : null;
  }
  return null;
}

function parseAddFileContent(lines: string[], startIndex: number): { content: string; nextIndex: number } {
  let content = '';
  let index = startIndex;
  while (index < lines.length && !lines[index].startsWith('***')) {
    if (lines[index].startsWith('+')) content += `${lines[index].slice(1)}\n`;
    index += 1;
  }
  if (content.endsWith('\n')) content = content.slice(0, -1);
  return { content, nextIndex: index };
}

function parseUpdateFileChunks(lines: string[], startIndex: number): { chunks: UpdateFileChunk[]; nextIndex: number } {
  const chunks: UpdateFileChunk[] = [];
  let index = startIndex;
  while (index < lines.length && !lines[index].startsWith('***')) {
    if (!lines[index].startsWith('@@')) {
      index += 1;
      continue;
    }
    const changeContext = lines[index].slice(2).trim() || undefined;
    index += 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let isEndOfFile = false;
    while (index < lines.length && !lines[index].startsWith('@@') && !lines[index].startsWith('***')) {
      const line = lines[index];
      if (line === '*** End of File') {
        isEndOfFile = true;
        index += 1;
        break;
      }
      if (line.startsWith(' ')) {
        const content = line.slice(1);
        oldLines.push(content);
        newLines.push(content);
      } else if (line.startsWith('-')) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1));
      }
      index += 1;
    }
    chunks.push({ oldLines, newLines, changeContext, isEndOfFile: isEndOfFile || undefined });
  }
  return { chunks, nextIndex: index };
}

function stripHeredoc(input: string): string {
  const match = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  return match ? match[2] : input;
}

export function parseApplyPatchEnvelope(patchText: string): PatchHunk[] {
  const cleaned = stripHeredoc(patchText.trim());
  const lines = cleaned.split('\n');
  const beginIndex = lines.findIndex((line) => line.trim() === '*** Begin Patch');
  const endIndex = lines.findIndex((line) => line.trim() === '*** End Patch');
  if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
    throw new Error('Invalid patch format: missing Begin/End markers.');
  }

  const hunks: PatchHunk[] = [];
  let index = beginIndex + 1;
  while (index < endIndex) {
    const header = parsePatchHeader(lines, index);
    if (!header) {
      index += 1;
      continue;
    }
    if (header.kind === 'add') {
      const { content, nextIndex } = parseAddFileContent(lines, header.nextIndex);
      hunks.push({ type: 'add', path: header.path, contents: content });
      index = nextIndex;
      continue;
    }
    if (header.kind === 'delete') {
      hunks.push({ type: 'delete', path: header.path });
      index = header.nextIndex;
      continue;
    }
    const { chunks, nextIndex } = parseUpdateFileChunks(lines, header.nextIndex);
    hunks.push({ type: 'update', path: header.path, movePath: header.movePath, chunks });
    index = nextIndex;
  }
  return hunks;
}

function normalizeUnicode(value: string): string {
  return value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
}

type Comparator = (left: string, right: string) => boolean;

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
  endOfFile: boolean,
): number {
  if (endOfFile) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex) {
      let matches = true;
      for (let offset = 0; offset < pattern.length; offset += 1) {
        if (!compare(lines[fromEnd + offset], pattern[offset])) {
          matches = false;
          break;
        }
      }
      if (matches) return fromEnd;
    }
  }

  for (let index = startIndex; index <= lines.length - pattern.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (!compare(lines[index + offset], pattern[offset])) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }

  return -1;
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, endOfFile = false): number {
  if (pattern.length === 0) return -1;
  const exact = tryMatch(lines, pattern, startIndex, (left, right) => left === right, endOfFile);
  if (exact !== -1) return exact;
  const rstrip = tryMatch(lines, pattern, startIndex, (left, right) => left.trimEnd() === right.trimEnd(), endOfFile);
  if (rstrip !== -1) return rstrip;
  const trimmed = tryMatch(lines, pattern, startIndex, (left, right) => left.trim() === right.trim(), endOfFile);
  if (trimmed !== -1) return trimmed;
  return tryMatch(
    lines,
    pattern,
    startIndex,
    (left, right) => normalizeUnicode(left.trim()) === normalizeUnicode(right.trim()),
    endOfFile,
  );
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex);
      if (contextIndex === -1) {
        throw new Error(`Failed to find context "${chunk.changeContext}" in ${filePath}.`);
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      replacements.push([originalLines.length, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, Boolean(chunk.isEndOfFile));
    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') newSlice = newSlice.slice(0, -1);
      found = seekSequence(originalLines, pattern, lineIndex, Boolean(chunk.isEndOfFile));
    }
    if (found === -1) {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join('\n')}`);
    }
    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((left, right) => left[0] - right[0]);
  return replacements;
}

export function deriveNewContentsFromChunks(filePath: string, chunks: UpdateFileChunk[], originalText: string): string {
  const originalLines = originalText.replace(/\r\n/g, '\n').split('\n');
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === '') originalLines.pop();
  const replacements = computeReplacements(originalLines, filePath, chunks);
  const result = [...originalLines];
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const [startIndex, oldLength, newSegment] = replacements[index];
    result.splice(startIndex, oldLength, ...newSegment);
  }
  if (result.length === 0 || result[result.length - 1] !== '') result.push('');
  return result.join('\n');
}
