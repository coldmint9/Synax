import type { WikiOutlineEntry } from './contracts.js';

export type WikiOutlineNodeKind = 'section' | 'document';

export function isSectionEntry(
  entry: Pick<WikiOutlineEntry, 'nodeKind'> & { isSection?: boolean },
): boolean {
  return entry.nodeKind === 'section' || entry.isSection === true;
}

export function isWritableOutlineEntry(entry: WikiOutlineEntry): boolean {
  return !isSectionEntry(entry);
}

export function countWritableOutlineEntries(entries: WikiOutlineEntry[]): number {
  return entries.filter(isWritableOutlineEntry).length;
}
