export interface ConflictBlock {
  ours: string;
  base: string | null;
  theirs: string;
}

export interface ParsedConflicts {
  parts: Array<string | ConflictBlock>;
  found: boolean;
  valid: boolean;
}

// Git permits conflict-marker-size attributes larger than the default seven.
export const CONFLICT_MARKER = /^(<{7,}|\|{7,}|={7,}|>{7,})(?:[ \t\r]|$)/m;

/** Preserve every byte outside a complete conflict block, including CRLF. */
export function parseConflictText(content: string): ParsedConflicts {
  const parts: ParsedConflicts['parts'] = [];
  let block: ConflictBlock | null = null;
  let side: keyof ConflictBlock = 'ours';
  let width = 0;
  let found = false;
  for (const line of content.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue;
    const marker = /^(<{7,}|\|{7,}|={7,}|>{7,})(?:[ \t\r\n]|$)/.exec(line)?.[1];
    if (marker) {
      found = true;
      if (!block && marker[0] === '<') {
        width = marker.length;
        block = { ours: '', base: null, theirs: '' };
        side = 'ours';
      } else if (block && marker.length === width && marker[0] === '|' && side === 'ours') {
        block.base = '';
        side = 'base';
      } else if (block && marker.length === width && marker[0] === '=' && side !== 'theirs') {
        side = 'theirs';
      } else if (block && marker.length === width && marker[0] === '>' && side === 'theirs') {
        parts.push(block);
        block = null;
      } else return { parts: [], found: true, valid: false };
    } else if (block) block[side] = (block[side] ?? '') + line;
    else if (typeof parts.at(-1) === 'string') parts[parts.length - 1] += line;
    else parts.push(line);
  }
  return { parts, found, valid: block === null };
}

export function resolveConflictBlock(block: ConflictBlock): string | undefined {
  if (block.ours === block.theirs) return block.ours;
  if (block.base !== null) {
    if (block.ours === block.base) return block.theirs;
    if (block.theirs === block.base) return block.ours;
  }
  // An empty side can represent an intentional deletion, not an unchanged side.
  return undefined;
}

export function resolveConflictText(content: string) {
  const parsed = parseConflictText(content);
  const resolved = parsed.parts.map(part => typeof part === 'string' ? part : resolveConflictBlock(part));
  return {
    found: parsed.found,
    resolved: parsed.found && parsed.valid && resolved.every(part => part !== undefined),
    content: parsed.valid && resolved.every(part => part !== undefined) ? resolved.join('') : content,
  };
}
