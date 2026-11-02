// Adapted from /Users/mint/opencode/packages/opencode/src/patch/index.ts
// so the local runtime can accept the same apply_patch-style envelope.

import {
  boundedActualExcerpt,
  boundedCandidates,
  boundedExcerpt,
  invalidPatchDiagnostic,
  PatchApplyError,
  type PatchDiagnostic,
} from "./patch-diagnostics.js";

export interface UpdateFileChunk {
  oldLines: string[];
  newLines: string[];
  changeContext?: string;
  isEndOfFile?: boolean;
  /** 1-based line in the patch envelope, for actionable diagnostics. */
  patchLine?: number;
}

export type PatchHunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; chunks: UpdateFileChunk[] };

function formatError(message: string, index?: number, path?: string, hunkIndex?: number): never {
  throw new PatchApplyError({
    ...invalidPatchDiagnostic(message,
      "No file was written. Use bare @@ or @@ followed by an exact source anchor, not unified-diff line numbers. Prefix context/deletions/additions with space/-/+; do not retry the malformed patch unchanged."),
    ...(index === undefined ? {} : { patchLine: index + 1 }),
    ...(path === undefined ? {} : { path }),
    ...(hunkIndex === undefined ? {} : { hunkIndex: hunkIndex + 1 }),
  });
}

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
      if (!movePath) formatError('Move to requires a non-empty path.', nextIndex, filePath);
      nextIndex += 1;
    }
    return filePath ? { kind: 'update', path: filePath, movePath, nextIndex } : null;
  }
  return null;
}

function parseAddFileContent(lines: string[], startIndex: number, filePath: string): { content: string; nextIndex: number } {
  let content = '';
  let index = startIndex;
  while (index < lines.length && !lines[index].startsWith('***')) {
    if (!lines[index].startsWith('+')) formatError('Add File lines must start with +.', index, filePath);
    content += `${lines[index].slice(1)}\n`;
    index += 1;
  }
  if (content.endsWith('\n')) content = content.slice(0, -1);
  return { content, nextIndex: index };
}

function parseUpdateFileChunks(lines: string[], startIndex: number, filePath: string): { chunks: UpdateFileChunk[]; nextIndex: number } {
  const chunks: UpdateFileChunk[] = [];
  let index = startIndex;
  while (index < lines.length && !lines[index].startsWith('***')) {
    if (lines[index] !== '@@' && !lines[index].startsWith('@@ ')) {
      formatError('Update File requires an @@ hunk header.', index, filePath, chunks.length);
    }
    if (/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(lines[index]))
      formatError('Unified-diff line-number headers are not supported.', index, filePath, chunks.length);
    const changeContext = lines[index].slice(2).trim() || undefined;
    index += 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let isEndOfFile = false;
    const patchLine = index;
    while (
      index < lines.length &&
      !lines[index].startsWith('@@') &&
      (!lines[index].startsWith('***') || lines[index] === '*** End of File')
    ) {
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
      } else {
        formatError('Hunk lines must start with space, - or + (including blank context lines).', index, filePath, chunks.length);
      }
      index += 1;
    }
    if (oldLines.length === 0 && newLines.length === 0)
      formatError('Empty update hunk.', patchLine - 1, filePath, chunks.length);
    chunks.push({
      oldLines,
      newLines,
      changeContext,
      isEndOfFile: isEndOfFile || undefined,
      patchLine,
    });
  }
  return { chunks, nextIndex: index };
}

function stripHeredoc(input: string): string {
  const match = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  return match ? match[2] : input;
}

export function parseApplyPatchEnvelope(patchText: string): PatchHunk[] {
  const cleaned = stripHeredoc(patchText.replace(/\r\n/g, '\n').trim());
  const lines = cleaned.split('\n');
  const beginIndex = lines.findIndex((line) => line === '*** Begin Patch');
  const endIndex = lines.findIndex((line) => line === '*** End Patch');
  if (beginIndex !== 0 || endIndex !== lines.length - 1 || beginIndex >= endIndex) {
    formatError('Invalid patch format: missing Begin/End markers.');
  }

  const hunks: PatchHunk[] = [];
  let index = beginIndex + 1;
  while (index < endIndex) {
    const header = parsePatchHeader(lines, index);
    if (!header) {
      formatError('Unknown patch header or missing path; Move to must follow Update File immediately.', index);
    }
    if (header.kind === 'add') {
      const { content, nextIndex } = parseAddFileContent(lines, header.nextIndex, header.path);
      hunks.push({ type: 'add', path: header.path, contents: content });
      index = nextIndex;
      continue;
    }
    if (header.kind === 'delete') {
      hunks.push({ type: 'delete', path: header.path });
      index = header.nextIndex;
      continue;
    }
    const { chunks, nextIndex } = parseUpdateFileChunks(lines, header.nextIndex, header.path);
    if (chunks.length === 0 && !header.movePath)
      formatError('Update File has no hunks.', index, header.path);
    hunks.push({ type: 'update', path: header.path, movePath: header.movePath, chunks });
    index = nextIndex;
  }
  if (hunks.length === 0) formatError('patch contains no file operations.');
  return hunks;
}

/** Best-effort path list for approval review and change tracking; [] if unparseable. */
export function patchFilePaths(patchText: unknown): string[] {
  if (typeof patchText !== 'string') return [];
  try {
    return parseApplyPatchEnvelope(patchText).flatMap((hunk) =>
      hunk.type === 'update' && hunk.movePath
        ? [hunk.path, hunk.movePath]
        : [hunk.path],
    );
  } catch {
    return [];
  }
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

interface SequenceSearch {
  index: number;
  candidates: number[];
}

function findMatches(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
  endOfFile: boolean,
): number[] {
  const candidates: number[] = [];
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
      if (matches) candidates.push(fromEnd);
    }
    return candidates;
  }

  for (let index = startIndex; index <= lines.length - pattern.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (!compare(lines[index + offset], pattern[offset])) {
        matches = false;
        break;
      }
    }
    if (matches) candidates.push(index);
    if (candidates.length === 8) break;
  }

  return candidates;
}

function seekSequence(
  lines: string[],
  pattern: string[],
  startIndex: number,
  endOfFile = false,
): SequenceSearch {
  if (pattern.length === 0) return { index: -1, candidates: [] };
  const comparators: Comparator[] = [
    (left, right) => left === right,
    (left, right) => left.trimEnd() === right.trimEnd(),
    (left, right) => left.trim() === right.trim(),
    (left, right) => normalizeUnicode(left.trim()) === normalizeUnicode(right.trim()),
  ];
  for (const compare of comparators) {
    const candidates = findMatches(lines, pattern, startIndex, compare, endOfFile);
    if (candidates.length > 0) return { index: candidates[0]!, candidates };
  }
  return { index: -1, candidates: [] };
}

function nearbyActualExcerpt(lines: string[], startIndex: number): PatchDiagnostic["actualExcerpt"] {
  const start = Math.max(0, startIndex - 2);
  // Keep one lookahead line so the excerpt can truthfully mark omitted lines.
  return boundedActualExcerpt(lines.slice(start, start + 13), start + 1);
}

function diagnosticForMismatch(input: {
  code: PatchDiagnostic["code"];
  message: string;
  filePath: string;
  chunk: UpdateFileChunk;
  hunkIndex: number;
  originalLines: string[];
  searchStart: number;
  pattern: string[];
  candidates?: number[];
}): PatchApplyError {
  const startLine = Math.max(1, input.searchStart + 1);
  // Full matches elsewhere are diagnostic evidence, never a fallback write.
  // A single exact context line can also suggest a useful read after drift.
  const firstContext = input.pattern.findIndex(line => line.trim().length > 0);
  const nearby = firstContext < 0 ? -1 : input.originalLines.indexOf(input.pattern[firstContext]);
  const evidenceIndex = Math.max(0, Math.min(
    input.candidates?.[0] ?? (nearby < 0 ? input.searchStart : nearby - firstContext),
    Math.max(0, input.originalLines.length - 1),
  ));
  const expected = boundedExcerpt(input.pattern);
  const diagnostic: PatchDiagnostic = {
    error: true,
    code: input.code,
    message: input.message,
    applied: false,
    recovery:
      "No file was written. Re-read the suggested range from the current file, then rebuild this hunk from that exact text; do not retry the same patch unchanged.",
    path: input.filePath,
    hunkIndex: input.hunkIndex + 1,
    patchLine: input.chunk.patchLine,
    searchStartLine: startLine,
    expectedExcerpt: expected,
    actualExcerpt: nearbyActualExcerpt(input.originalLines, evidenceIndex),
    suggestedRead: {
      path: input.filePath,
      startLine: Math.max(1, evidenceIndex - 2),
      lineCount: Math.min(40, Math.max(8, input.pattern.length + 6)),
    },
  };
  if (input.chunk.changeContext) diagnostic.anchor = input.chunk.changeContext;
  const candidates = boundedCandidates((input.candidates ?? []).map((index) => index + 1));
  if (candidates.length > 0) diagnostic.candidateLines = candidates;
  return new PatchApplyError(diagnostic);
}

type ChunkFailure = (
  code: PatchDiagnostic["code"],
  message: string,
  pattern: string[],
  candidates?: number[],
) => never;

interface AnchorResolution {
  anchor: number;
  /** Body position already proven by the surviving anchor; skip the search. */
  body?: number;
}

/**
 * A repeated anchor line only says "the hunk starts somewhere below these
 * lines", so the hunk itself picks the occurrence: the anchor the body
 * directly follows wins and pins the body there, and otherwise the first
 * occurrence is just the search start while the body's own uniqueness gate
 * still rejects real ambiguity. Only a body that fits several occurrences stays
 * ambiguous, and an insertion without a body still needs a unique anchor.
 */
function resolveAnchorIndex(input: {
  lines: string[];
  anchor: string;
  candidates: number[];
  chunk: UpdateFileChunk;
  filePath: string;
  fail: ChunkFailure;
}): AnchorResolution {
  const { lines, anchor, candidates, chunk, filePath, fail } = input;
  const first = candidates[0]!;
  if (candidates.length === 1) return { anchor: first };
  if (chunk.oldLines.length === 0) {
    fail(
      "PATCH_AMBIGUOUS_MATCH",
      `Context is ambiguous in ${filePath}; an insertion needs an anchor that appears once.`,
      [anchor], candidates,
    );
  }
  const endOfFile = Boolean(chunk.isEndOfFile);
  const following = candidates.filter((candidate) =>
    seekSequence(lines, chunk.oldLines, candidate + 1, endOfFile).index === candidate + 1);
  if (following.length === 1) return { anchor: following[0]!, body: following[0]! + 1 };
  if (following.length > 1) {
    fail(
      "PATCH_AMBIGUOUS_MATCH",
      `Expected lines are ambiguous in ${filePath}: ${following.length} anchor occurrences are followed by this hunk. Add unique context inside the hunk.`,
      chunk.oldLines, following,
    );
  }
  return { anchor: first };
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const [hunkIndex, chunk] of chunks.entries()) {
    let pinnedBody: number | undefined;
    const fail = (
      code: PatchDiagnostic["code"],
      message: string,
      pattern: string[],
      candidates: number[] = [],
    ): never => {
      throw diagnosticForMismatch({
        code, message, filePath, chunk, hunkIndex, originalLines,
        searchStart: lineIndex, pattern, candidates,
      });
    };
    if (chunk.changeContext) {
      const context = seekSequence(originalLines, [chunk.changeContext], lineIndex);
      if (context.index === -1) {
        const before = seekSequence(originalLines, [chunk.changeContext], 0);
        fail(
          before.index >= 0 && before.index < lineIndex
            ? "PATCH_HUNK_ORDER_CONFLICT" : "PATCH_ANCHOR_NOT_FOUND",
          `Failed to find context in ${filePath}. The anchor must be a current source line after the preceding hunk.`,
          [chunk.changeContext], before.candidates,
        );
      }
      const resolution = resolveAnchorIndex({
        lines: originalLines,
        anchor: chunk.changeContext,
        candidates: context.candidates,
        chunk,
        filePath,
        fail,
      });
      lineIndex = resolution.anchor + 1;
      pinnedBody = resolution.body;
    }

    if (chunk.oldLines.length === 0) {
      // An unanchored addition-only chunk appends; an anchor explicitly selects
      // an insertion point immediately after its source line.
      const insertion = chunk.changeContext ? lineIndex : originalLines.length;
      if (chunk.isEndOfFile && insertion !== originalLines.length) {
        fail("PATCH_CONTEXT_MISMATCH", "End of File insertion is not at EOF.", []);
      }
      replacements.push([insertion, 0, chunk.newLines]);
      lineIndex = insertion;
      continue;
    }

    const pattern = chunk.oldLines;
    const search = pinnedBody === undefined
      ? seekSequence(originalLines, pattern, lineIndex, Boolean(chunk.isEndOfFile))
      : { index: pinnedBody, candidates: [pinnedBody] };
    if (search.index === -1) {
      const before = seekSequence(originalLines, pattern, 0);
      const outOfOrder = before.index >= 0 && before.index < lineIndex;
      fail(
        outOfOrder ? "PATCH_HUNK_ORDER_CONFLICT" : "PATCH_CONTEXT_MISMATCH",
        outOfOrder
          ? `Failed to find expected lines in ${filePath}: text exists before the search cursor. Order hunks by original position and merge overlapping context; do not repeat the @@ anchor inside the hunk.`
          : `Failed to find expected lines in ${filePath}. All hunks use the pre-edit file, not earlier hunk results.${chunk.isEndOfFile ? ' The hunk must end at EOF.' : ''}`,
        chunk.oldLines, before.candidates,
      );
    }
    if (search.candidates.length > 1) {
      fail("PATCH_AMBIGUOUS_MATCH", `Expected lines are ambiguous in ${filePath}; add unique context instead of choosing the first match.`,
        pattern, search.candidates);
    }
    replacements.push([search.index, pattern.length, chunk.newLines]);
    lineIndex = search.index + pattern.length;
  }

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
  // Original terminal newline was removed before matching; every remaining
  // empty line is actual content, not a newline sentinel to discard.
  return result.length === 0 ? '' : `${result.join('\n')}\n`;
}
