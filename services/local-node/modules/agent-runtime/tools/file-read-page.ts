import fs from 'node:fs';

const SAMPLE_BYTES = 8_192;
const MAX_LINE_SCAN_BYTES = 16 * 1024 * 1024;

function revisionOf(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function readRange(fd: number, offset: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, bytes, read, length - read, offset + read);
    if (count === 0) throw new Error('File changed while reading (unexpected EOF). Restart file.read at byteOffset 0.');
    read += count;
  }
  return bytes;
}

function assertText(bytes: Buffer): void {
  const sample = bytes.subarray(0, SAMPLE_BYTES);
  let nulls = 0;
  for (const byte of sample) if (byte === 0) nulls++;
  if (nulls > sample.length * 0.01) {
    throw new Error('Refused: file contains binary content. file.read only supports text files.');
  }
}

export interface FileLineRange {
  startLine: number;
  lineCount: number;
}

/** Locate a 1-based line without buffering the prefix or scanning unbounded files. */
function lineOffset(fd: number, size: number, startLine: number): number {
  let line = 1;
  let offset = 0;
  while (line < startLine && offset < size) {
    if (offset >= MAX_LINE_SCAN_BYTES)
      throw new Error('Line lookup exceeds the 16 MiB scan budget. Use file.read byteOffset/nextByteOffset pagination with expectedRevision instead.');
    const chunk = readRange(fd, offset, Math.min(SAMPLE_BYTES, size - offset, MAX_LINE_SCAN_BYTES - offset));
    let index = -1;
    while ((index = chunk.indexOf(10, index + 1)) !== -1) {
      if (++line === startLine) return offset + index + 1;
    }
    offset += chunk.length;
  }
  if (line < startLine) throw new Error('startLine exceeds the file line range. Re-read a lower range or use byte pagination.');
  return offset;
}

export interface FileReadPage {
  bytes: Buffer;
  content: string;
  stat: fs.Stats;
  revision: string;
  eof: boolean;
  byteOffset: number;
  startLine?: number;
  endLine?: number;
  lineCount?: number;
  lineComplete?: boolean;
}

/** Filesystem adapter: one descriptor, bounded buffers, stable version, UTF-8 boundaries. */
export function readFilePage(
  filePath: string,
  byteOffset: number,
  maxBytes: number,
  expectedRevision?: string,
  lines?: FileLineRange,
): FileReadPage {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 64_000) {
    throw new Error('Invalid file page range: require byteOffset >= 0 and a page budget of 4–64000 safe integer bytes.');
  }
  if (lines && (byteOffset !== 0 || !Number.isSafeInteger(lines.startLine) || lines.startLine < 1 ||
    !Number.isSafeInteger(lines.lineCount) || lines.lineCount < 1 || lines.lineCount > 1000))
    throw new Error('Invalid line range: startLine >= 1, lineCount 1–1000, and no byteOffset.');
  const before = fs.statSync(filePath);
  if (!before.isFile()) throw new Error('path must point to a file.');
  const revision = revisionOf(before);
  const changed = () => new Error('File changed while reading. Restart file.read at byteOffset 0.');
  if (expectedRevision !== undefined && expectedRevision !== revision) throw changed();
  if (byteOffset > before.size) throw new Error(`byteOffset exceeds file size ${before.size}; use a returned nextByteOffset or restart at 0.`);

  // Nonblocking open prevents a concurrent replacement with a FIFO from hanging.
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || revisionOf(stat) !== revision) throw changed();
    if (lines) byteOffset = lineOffset(fd, stat.size, lines.startLine);
    const sampleLength = Math.min(stat.size, SAMPLE_BYTES);
    // At offset zero the page read doubles as the binary sample. At later
    // offsets sample the header as well, so skipping a binary prefix cannot help.
    const readLength = byteOffset === 0
      ? Math.min(stat.size, Math.max(sampleLength, maxBytes + 1))
      : Math.min(stat.size - byteOffset, maxBytes + 1);
    const buffer = readRange(fd, byteOffset, readLength);
    assertText(byteOffset === 0 ? buffer : readRange(fd, 0, sampleLength));
    assertText(buffer);
    if (buffer.length && (buffer[0]! & 0xc0) === 0x80) {
      throw new Error('byteOffset is inside a UTF-8 character. Use nextByteOffset returned by file.read.');
    }
    let end = Math.min(maxBytes, buffer.length);
    if (lines) {
      let newline = -1;
      for (let count = 0; count < lines.lineCount; count++) {
        newline = buffer.indexOf(10, newline + 1);
        if (newline < 0 || newline >= end) break;
        if (count + 1 === lines.lineCount) end = newline + 1;
      }
    }
    // Lookahead byte tells us whether the cut lands inside a multibyte character.
    while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
    if (buffer.length && end === 0) throw new Error('Invalid UTF-8 text at the requested page boundary.');
    const bytes = buffer.subarray(0, end);
    let content: string;
    try {
      // Preserve BOMs, including embedded BOMs at the beginning of later pages.
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error('Refused: file page is not valid UTF-8 text. Use a suitable media or encoding-aware tool.');
    }
    if (revisionOf(fs.fstatSync(fd)) !== revision || revisionOf(fs.statSync(filePath)) !== revision) throw changed();
    const eof = byteOffset + bytes.length === stat.size;
    let lineCount = 0;
    if (lines && bytes.length) {
      for (const byte of bytes) if (byte === 10) lineCount++;
      if (bytes.at(-1) !== 10) lineCount++;
    }
    return {
      bytes, content, stat, revision, eof, byteOffset,
      ...(lines ? {
        startLine: lines.startLine,
        endLine: lines.startLine + lineCount - 1,
        lineCount,
        lineComplete: eof || bytes.at(-1) === 10,
      } : {}),
    };
  } finally {
    fs.closeSync(fd);
  }
}
