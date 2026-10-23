import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { AgentValidationError } from './runtime-errors.js';

/** Read at most the preview budget plus one byte. Never allocate the full file
 * before truncating it. A small concurrent-read cap bounds aggregate buffers. */
let activeReads = 0;
const MAX_READS = 4;
export async function readWorkspacePreview(filename: string, limit: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 20 * 1024 * 1024)
    throw new AgentValidationError('Invalid preview size.');
  if (activeReads >= MAX_READS) throw new AgentValidationError('Too many file previews are loading. Retry after the current read finishes.');
  activeReads++;
  try {
    const file = await open(filename, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new AgentValidationError('Preview requires a regular file.');
      const capacity = Math.min(stat.size, limit + 1);
      const bytes = Buffer.allocUnsafe(capacity);
      let offset = 0;
      while (offset < capacity) {
        const read = await file.read(bytes, offset, capacity - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      return { bytes: bytes.subarray(0, Math.min(offset, limit)), truncated: stat.size > limit || offset > limit };
    } finally { await file.close(); }
  } finally { activeReads--; }
}

/** Do not render an incomplete UTF-8 code point at a truncated byte boundary. */
export function previewText(bytes: Buffer, truncated: boolean): string {
  const decoder = new StringDecoder('utf8');
  const text = decoder.write(bytes);
  return truncated ? text : text + decoder.end();
}
