/** Bounded line LCS. Large or very different files report bytes without invented counts. */
export function diffStats(before: string, after: string): { additions?: number; deletions?: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > 1024 * 1024) return {};
  const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let a = lines(before), b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  a = a.slice(start); b = b.slice(start);
  while (a.length && b.length && a.at(-1) === b.at(-1)) { a.pop(); b.pop(); }
  if (a.length * b.length > 2_000_000) return {};
  let previous = new Uint32Array(b.length + 1);
  for (const line of a) {
    const current = new Uint32Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) current[j] = line === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    previous = current;
  }
  return { additions: b.length - previous[b.length], deletions: a.length - previous[b.length] };
}
