import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSchema } from '../../../infrastructure/llm-runtime/tool-schema.js';
import { fileReadTool } from '../tools/file-read.js';
import { clearSessionFileReads, getSessionReadPaths, assertSessionFileReadForWrite, compareSessionFileRead } from '../read-tracker.js';
import { clearSessionWorkspaceRoot, setSessionWorkspaceRoot } from '../tools/workspace.js';

interface Page {
  content: string;
  nextByteOffset: number | null;
  byteOffset: number;
  bytesRead: number;
  revision: string;
  truncated: boolean;
  effectiveMaxBytes: number;
  eof: boolean;
  startLine?: number;
  endLine?: number;
  lineCount?: number;
  lineComplete?: boolean;
}

let root: string;
let sessionId: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-file-read-'));
  sessionId = path.basename(root);
  setSessionWorkspaceRoot(sessionId, root);
});
afterEach(() => {
  vi.restoreAllMocks();
  clearSessionFileReads(sessionId);
  clearSessionWorkspaceRoot(sessionId);
  fs.rmSync(root, { recursive: true, force: true });
});

async function read(args: Record<string, unknown> = {}): Promise<Page> {
  const execution = await fileReadTool.execute({
    sessionId, runId: null, stepId: null, toolCallId: 'page',
    toolId: 'file.read', category: 'read', mutability: 'read',
    args: fileReadTool.inputSchema!.parse({ path: 'text.txt', ...args }),
  });
  return execution.result as Page;
}
function write(text: string | Buffer) { fs.writeFileSync(path.join(root, 'text.txt'), text); }

describe('file.read pagination', () => {
  it('reads an exact line range while preserving BOM, CRLF and UTF-8', async () => {
    write('\ufefffirst\r\n甲🙂\r\nlast\n');
    const page = await read({ startLine: 2, lineCount: 1 });
    expect(page).toMatchObject({ content: '甲🙂\r\n', startLine: 2, endLine: 2, lineCount: 1, lineComplete: true, eof: false });
    expect(page.byteOffset).toBe(Buffer.byteLength('\ufefffirst\r\n'));
    const next = await read({ byteOffset: page.nextByteOffset, expectedRevision: page.revision });
    expect(next.content).toBe('last\n');
  });

  it('exposes partial last lines and lossless byte continuation under a line budget', async () => {
    write('header\n甲🙂tail\nlast\n');
    const page = await read({ startLine: 2, lineCount: 1, maxBytes: 4 });
    expect(page).toMatchObject({ content: '甲', lineComplete: false, startLine: 2, endLine: 2, lineCount: 1 });
    const rest = await read({ byteOffset: page.nextByteOffset, expectedRevision: page.revision });
    expect(page.content + rest.content).toBe('甲🙂tail\nlast\n');
    expect(compareSessionFileRead(sessionId, 'text.txt', Buffer.from('header\n甲🙂tail\nlast\n'))).toBe('unknown');
  });

  it('requires line mode to be explicit and disjoint from byte mode', async () => {
    for (const args of [
      { lineCount: 1 }, { startLine: 0 }, { startLine: 1.5 },
      { startLine: 1, byteOffset: 0 }, { startLine: 1, lineCount: 0 },
    ]) expect(fileReadTool.inputSchema!.safeParse({ path: 'text.txt', ...args }).success).toBe(false);
    write('x\n'.repeat(1200));
    expect(await read({ startLine: 1, lineCount: 100_000 })).toMatchObject({ lineCount: 1000, effectiveLineCount: 1000 });
    const schema = await asSchema(fileReadTool.inputSchema!).jsonSchema;
    expect(schema).toMatchObject({ type: 'object', properties: { startLine: { type: 'integer' }, lineCount: { type: 'integer' } } });
  });

  it('handles missing final newline, empty lines, EOF and beyond EOF', async () => {
    write('one\n\nlast');
    expect(await read({ startLine: 2, lineCount: 2 })).toMatchObject({ content: '\nlast', lineCount: 2, endLine: 3, eof: true, lineComplete: true });
    await expect(read({ startLine: 4 })).rejects.toThrow(/exceeds.*line range/);
    write('one\n');
    expect(await read({ startLine: 2 })).toMatchObject({ content: '', lineCount: 0, endLine: 1, eof: true });
    write('');
    expect(await read({ startLine: 1 })).toMatchObject({ content: '', lineCount: 0, eof: true });
  });

  it('caps line lookup I/O and closes the descriptor when the scan budget is exceeded', async () => {
    write('x'.repeat(16 * 1024 * 1024 + 2));
    const full = vi.spyOn(fs, 'readFileSync');
    const originalRead = fs.readSync;
    let requestedBytes = 0;
    vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      requestedBytes += length;
      return originalRead(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);
    const close = vi.spyOn(fs, 'closeSync');
    await expect(read({ startLine: 2, lineCount: 1 })).rejects.toThrow(/16 MiB scan budget.*byteOffset/);
    expect(full).not.toHaveBeenCalled();
    expect(requestedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(close).toHaveBeenCalledTimes(1);
    expect(getSessionReadPaths(sessionId)).toEqual([]);
  });

  it('keeps snapshot comparisons advisory and never advances the stored baseline', async () => {
    write('first\nsecond\n');
    const original = Buffer.from('first\nsecond\n');
    expect(compareSessionFileRead(sessionId, 'text.txt', original)).toBe('unknown');
    await read({ startLine: 1, lineCount: 2 });
    const full = vi.spyOn(fs, 'readFileSync');
    expect(compareSessionFileRead(sessionId, 'text.txt', original)).toBe('unchanged');
    expect(compareSessionFileRead(sessionId, path.join(root, 'text.txt'), Buffer.from('changed'))).toBe('changed');
    expect(compareSessionFileRead(sessionId, 'text.txt', original)).toBe('unchanged');
    expect(full).not.toHaveBeenCalled();
  });

  it('rejects stale revisions and concurrent changes during line scanning', async () => {
    write('a\nb\nc\n');
    const first = await read({ startLine: 2, lineCount: 1 });
    write('a\nchanged\nc\n');
    await expect(read({ startLine: 2, expectedRevision: first.revision })).rejects.toThrow(/changed while reading/);
    const originalRead = fs.readSync;
    vi.spyOn(fs, 'readSync').mockImplementationOnce(((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args);
      write('different\ncontent\n');
      return count;
    }) as typeof fs.readSync);
    await expect(read({ startLine: 2, lineCount: 1 })).rejects.toThrow(/changed while reading/);
  });

  it.each([1, 2, 3, 4, 7, 64_000])('reassembles UTF-8 including BOM and emoji with budget %i', async maxBytes => {
    const text = '\ufeff甲🙂e\u0301乙\r\n\ufeff'.repeat(maxBytes === 64_000 ? 4000 : 3);
    write(text);
    const pages: string[] = [];
    let byteOffset = 0;
    let expectedRevision: string | undefined;
    for (let i = 0; i <= Buffer.byteLength(text); i++) {
      const page = await read({ maxBytes, byteOffset, expectedRevision });
      expect(page.byteOffset).toBe(byteOffset);
      expect(Buffer.byteLength(page.content)).toBe(page.bytesRead);
      expect(page.bytesRead).toBeLessThanOrEqual(page.effectiveMaxBytes);
      pages.push(page.content);
      if (page.nextByteOffset === null) {
        expect(page).toMatchObject({ eof: true, truncated: false });
        break;
      }
      expect(page.nextByteOffset).toBe(byteOffset + page.bytesRead);
      expect(page.nextByteOffset).toBeGreaterThan(byteOffset);
      byteOffset = page.nextByteOffset;
      expectedRevision = page.revision;
    }
    expect(pages.join('')).toBe(text);
  });

  it.each([65_536, 100_000])('accepts oversized budget %i through schema and bounds actual I/O', async maxBytes => {
    write('x'.repeat(2_000_000));
    const fullRead = vi.spyOn(fs, 'readFileSync');
    const requestedLengths: number[] = [];
    const originalRead = fs.readSync;
    const ranged = vi.spyOn(fs, 'readSync').mockImplementation(((fd, buffer, offset, length, position) => {
      if (typeof length === 'number') requestedLengths.push(length);
      return originalRead(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);
    const first = await read({ maxBytes });
    expect(first).toMatchObject({ effectiveMaxBytes: 64_000, bytesRead: 64_000, truncated: true });
    expect(first.content).toBe('x'.repeat(64_000));
    expect(fullRead).not.toHaveBeenCalled();
    expect(requestedLengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(64_001);
    requestedLengths.length = 0;
    await read({ byteOffset: first.nextByteOffset, expectedRevision: first.revision, maxBytes: 4 });
    expect(requestedLengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(8_192 + 5);
    expect(fullRead).not.toHaveBeenCalled();
  });

  it('publishes integer budget schemas without the old page-size rejection', async () => {
    const schema = await asSchema(fileReadTool.inputSchema!).jsonSchema;
    const properties = schema.properties as Record<string, { type?: string; maximum?: number }>;
    expect(properties.maxBytes).toMatchObject({ type: 'integer', maximum: Number.MAX_SAFE_INTEGER });
    for (const maxBytes of [0, -1, 1.5, '64000', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(fileReadTool.inputSchema!.safeParse({ path: 'text.txt', maxBytes }).success).toBe(false);
    }
    expect(fileReadTool.inputSchema!.safeParse({ path: 'text.txt', byteOffset: 1 }).success).toBe(false);
    expect(fileReadTool.inputSchema!.safeParse({ path: 'text.txt', byteOffset: -1 }).success).toBe(false);
  });

  it('handles an empty file, exact EOF and beyond EOF', async () => {
    write('');
    expect(await read()).toMatchObject({ content: '', bytesRead: 0, nextByteOffset: null, eof: true });
    write('abcd');
    const first = await read({ maxBytes: 4 });
    expect(first).toMatchObject({ content: 'abcd', nextByteOffset: null, eof: true });
    expect(await read({ byteOffset: 4, expectedRevision: first.revision })).toMatchObject({ content: '', bytesRead: 0, eof: true });
    await expect(read({ byteOffset: 5, expectedRevision: first.revision })).rejects.toThrow(/exceeds file size/);
  });

  it('rejects changed and replaced files without updating the read baseline', async () => {
    write('abcdefgh');
    const first = await read({ maxBytes: 4 });
    const file = path.join(root, 'text.txt');
    const stat = fs.statSync(file);
    write('12345678');
    fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 60_000));
    await expect(read({ byteOffset: first.nextByteOffset, expectedRevision: first.revision })).rejects.toThrow(/changed while reading/);
    expect(() => assertSessionFileReadForWrite(sessionId, 'text.txt')).toThrow(/changed on disk/);
    const second = await read({ maxBytes: 4 });
    fs.renameSync(file, path.join(root, 'old.txt'));
    write('12345678');
    await expect(read({ byteOffset: second.nextByteOffset, expectedRevision: second.revision })).rejects.toThrow(/changed while reading/);
  });

  it('rejects mid-character offsets and invalid UTF-8 instead of losing bytes', async () => {
    write('甲🙂乙');
    const first = await read({ maxBytes: 4 });
    await expect(read({ byteOffset: 1, expectedRevision: first.revision })).rejects.toThrow(/inside a UTF-8 character/);
    write(Buffer.from([0xff, 0xfe, 0x41]));
    await expect(read()).rejects.toThrow(/not valid UTF-8/);
  });

  it('keeps binary and path restrictions for paged reads', async () => {
    write(Buffer.alloc(20));
    await expect(read()).rejects.toThrow(/binary content/);
    fs.writeFileSync(path.join(root, 'image.png'), 'not text');
    await expect(read({ path: 'image.png' })).rejects.toThrow(/binary file/);
    await expect(read({ path: '../outside.txt' })).rejects.toThrow(/outside|not found/i);
    await expect(read({ path: '.' })).rejects.toThrow();
  });

  it('handles short reads and closes the descriptor on success and failure', async () => {
    write('abc甲🙂def');
    const original = fs.readSync;
    vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
      original(fd, buffer, offset, Math.min(length, 2), position)) as typeof fs.readSync);
    const close = vi.spyOn(fs, 'closeSync');
    expect((await read()).content).toBe('abc甲🙂def');
    expect(close).toHaveBeenCalledTimes(1);
    vi.mocked(fs.readSync).mockImplementationOnce(() => { throw new Error('I/O failed'); });
    await expect(read()).rejects.toThrow('I/O failed');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('fails if the file changes during the first read and does not mark it read', async () => {
    write('abcdefgh');
    const original = fs.readSync;
    vi.spyOn(fs, 'readSync').mockImplementationOnce(((...args: Parameters<typeof fs.readSync>) => {
      const count = original(...args);
      write('new content');
      return count;
    }) as typeof fs.readSync);
    await expect(read({ maxBytes: 4 })).rejects.toThrow(/changed while reading/);
    expect(getSessionReadPaths(sessionId)).toEqual([]);
  });
});
