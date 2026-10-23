export interface LineAnchor {
  from: number;
  to: number;
  length: number;
}
export interface ConflictRange {
  start: number;
  end: number;
}
export interface MergeAnalysis {
  generation: number;
  version: number;
  conflicts: ConflictRange[];
  target: LineAnchor[];
  source: LineAnchor[];
  degraded: boolean;
}
export interface MergeAnalysisInput {
  generation: number;
  version: number;
  target: string;
  result: string;
  source: string;
  skipAlignment?: boolean;
}

export function findConflictRanges(text: string): ConflictRange[] {
  const ranges: ConflictRange[] = [];
  let line = 1,
    start = 0,
    pending: number | undefined;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const value = text.slice(start, end).replace(/\r$/, "");
    if (/^<{7,}(?:\s.*)?$/.test(value)) {
      if (pending !== undefined) ranges.push({ start: pending, end: line - 1 });
      pending = line;
    } else if (/^>{7,}(?:\s.*)?$/.test(value) && pending !== undefined) {
      ranges.push({ start: pending, end: line });
      pending = undefined;
    } else if (
      pending === undefined &&
      /^(?:={7,}|\|{7,}|>{7,})(?:\s.*)?$/.test(value)
    ) {
      ranges.push({ start: line, end: line });
    }
    if (end === text.length) break;
    start = end + 1;
    line++;
  }
  if (pending !== undefined) ranges.push({ start: pending, end: line });
  return ranges;
}

/** Patience anchors: unique lines + longest increasing subsequence, O(n log n).
 * Repeated lines are deliberately not diffed recursively. An approximate viewport
 * mapping is safer than a quadratic exact diff on adversarial generated files. */
function anchors(result: string[], side: string[]): LineAnchor[] {
  const positions = (lines: string[]) => {
    const map = new Map<string, number>();
    for (let index = 0; index < lines.length; index++)
      map.set(lines[index], map.has(lines[index]) ? -1 : index);
    return map;
  };
  const from = positions(result),
    to = positions(side);
  const pairs: { from: number; to: number }[] = [];
  for (let index = 0; index < result.length; index++) {
    if (from.get(result[index]) !== index) continue;
    const match = to.get(result[index]);
    if (match !== undefined && match >= 0)
      pairs.push({ from: index + 1, to: match + 1 });
  }
  const tails: number[] = [],
    previous = new Int32Array(pairs.length).fill(-1);
  for (let index = 0; index < pairs.length; index++) {
    let low = 0,
      high = tails.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (pairs[tails[mid]].to < pairs[index].to) low = mid + 1;
      else high = mid;
    }
    if (low) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const ordered: { from: number; to: number }[] = [];
  for (
    let index = tails.length ? tails[tails.length - 1] : -1;
    index >= 0;
    index = previous[index]
  )
    ordered.push(pairs[index]);
  ordered.reverse();
  const mappings: LineAnchor[] = [];
  for (const pair of ordered) {
    const last = mappings[mappings.length - 1];
    if (
      last &&
      pair.from === last.from + last.length &&
      pair.to === last.to + last.length
    )
      last.length++;
    else mappings.push({ ...pair, length: 1 });
  }
  return mappings;
}

export function analyzeMerge(input: MergeAnalysisInput): MergeAnalysis {
  const conflicts = findConflictRanges(input.result);
  const tooManyLines = (text: string) => {
    let count = 1;
    for (let index = 0; index < text.length; index++)
      if (text.charCodeAt(index) === 10 && ++count > 80_000) return true;
    return false;
  };
  const oversized =
    input.skipAlignment ||
    Math.max(input.result.length, input.target.length, input.source.length) >
      4 * 1024 * 1024 ||
    tooManyLines(input.result) ||
    tooManyLines(input.target) ||
    tooManyLines(input.source);
  const result = oversized ? [] : input.result.split(/\r?\n/);
  const target = oversized
    ? undefined
    : anchors(result, input.target.split(/\r?\n/));
  const source = oversized
    ? undefined
    : anchors(result, input.source.split(/\r?\n/));
  return {
    generation: input.generation,
    version: input.version,
    conflicts,
    target: target ?? [],
    source: source ?? [],
    degraded: !target || !source,
  };
}

/** Map a viewport anchor through unchanged spans, interpolating changed ranges. */
export function mapMergeLine(
  line: number,
  mappings: LineAnchor[],
  fromCount: number,
  toCount: number,
  reverse = false,
): number {
  const fromKey = reverse ? "to" : "from",
    toKey = reverse ? "from" : "to";
  let low = 0,
    high = mappings.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (mappings[mid][fromKey] <= line) low = mid + 1;
    else high = mid;
  }
  const previous = mappings[low - 1],
    next = mappings[low];
  if (previous && line < previous[fromKey] + previous.length)
    return previous[toKey] + line - previous[fromKey];
  const fromStart = previous ? previous[fromKey] + previous.length : 1;
  const toStart = previous ? previous[toKey] + previous.length : 1;
  const fromEnd = next ? next[fromKey] : fromCount;
  const toEnd = next ? next[toKey] : toCount;
  const mapped =
    fromEnd <= fromStart
      ? toStart
      : toStart +
        ((line - fromStart) * (toEnd - toStart)) / (fromEnd - fromStart);
  return Math.max(1, Math.min(toCount, Math.round(mapped)));
}
