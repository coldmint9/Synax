import { describe, expect, it } from 'vitest';
import { conflictHunks, resolveHunks } from '../conflict-hunks.js';

const conflict = '<<<<<<< HEAD\ntarget\n||||||| base\nbase\n=======\nsource\n>>>>>>> branch\n';
const file = (result: string) => ({ result, kind: 'text' as const, editable: true });

describe('conflict block resolution', () => {
  it('replaces only selected blocks and preserves both sides of automatically merged code', () => {
    const content = `source-only change\n${conflict}target-only change\n${conflict}tail\n`;
    const hunks = conflictHunks(content);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ target: 'target\n', source: 'source\n', base: 'base\n', startLine: 2 });
    const first = resolveHunks(file(content), [{ hunkId: hunks[0].id, choice: 'target' }]);
    expect(first).toEqual({ content: `source-only change\ntarget\ntarget-only change\n${conflict}tail\n`, resolve: false, remaining: 1 });
    const last = conflictHunks(first.content)[0];
    expect(resolveHunks(file(first.content), [{ hunkId: last.id, content: 'combined\n' }]))
      .toEqual({ content: 'source-only change\ntarget\ntarget-only change\ncombined\ntail\n', resolve: true, remaining: 0 });
  });
  it('retains CRLF and custom marker widths without normalizing untouched bytes', () => {
    const text = `prefix\n${conflict.replace(/<{7}|\|{7}|={7}|>{7}/g, value => value + value[0]).replace(/\n/g, '\r\n')}tail`;
    const hunk = conflictHunks(text)[0];
    expect(resolveHunks(file(text), [{ hunkId: hunk.id, choice: 'source' }]).content).toBe('prefix\nsource\r\ntail');
  });
  it('supports two-way markers but never invents a missing base', () => {
    const text = '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> source';
    const hunk = conflictHunks(text)[0];
    expect(hunk.base).toBeUndefined();
    expect(() => resolveHunks(file(text), [{ hunkId: hunk.id, choice: 'base' }])).toThrow('no base');
  });
  it.each(['<<<<<<< HEAD\na\n', '=======\n', conflict.replace('=======', '========'), conflict.replace('target\n', '<<<<<<< nested\n')])('rejects ambiguous markers: %s', text => {
    expect(() => conflictHunks(text)).toThrow('ambiguous');
  });
  it('rejects stale/duplicate ids and marker-containing replacement text', () => {
    const hunk = conflictHunks(conflict)[0];
    expect(() => resolveHunks(file(conflict), [{ hunkId: 'old', choice: 'source' }])).toThrow('Unknown');
    expect(() => resolveHunks(file(conflict), Array(2).fill({ hunkId: hunk.id, choice: 'source' }))).toThrow('duplicate');
    expect(() => resolveHunks(file(conflict), [{ hunkId: hunk.id, content: conflict }])).toThrow('markers');
  });
});
