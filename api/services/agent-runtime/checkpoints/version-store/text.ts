import { VersionObjects } from "./objects.js";
import { VersionTree } from "./tree.js";
import { CHUNK_BYTES, VersionStoreError, assertObjectId } from "./limits.js";
import { atomicVersionWrite } from "./transaction.js";

export const MAX_TEXT_BYTES = 16 * 1024 * 1024;
export interface TextInfo {
  kind: "text";
  version: 1;
  bytes: number;
  chars: number;
  jsonBytes: number;
  chunks: number;
  root: string | null;
}
const key = (index: number) => index.toString().padStart(10, "0");
function invalid(): never {
  throw new VersionStoreError(
    "VERSION_TEXT_CORRUPT",
    "Text manifest or chunk integrity check failed.",
  );
}

/** JSON-encoded chunks preserve lone surrogates too. Chunk boundaries never split
 * valid pairs, so raw/JSON byte counts compose exactly without lossy UTF-8 repair. */
export class VersionText {
  private readonly tree: VersionTree;
  constructor(private readonly objects: VersionObjects) {
    this.tree = new VersionTree(objects);
  }

  write(value: string): string {
    if (
      typeof value !== "string" ||
      value.length > MAX_TEXT_BYTES ||
      Buffer.byteLength(value) > MAX_TEXT_BYTES
    )
      throw new VersionStoreError(
        "VERSION_TEXT_SIZE",
        "Text exceeds its per-value size limit; use streamed ingestion.",
      );
    return atomicVersionWrite(this.objects.db, () => {
      let root: string | null = null,
        chunks = 0,
        jsonBytes = 2;
      const batch: { key: string; value: string }[] = [];
      for (let offset = 0; offset < value.length; ) {
        let end = Math.min(value.length, offset + 16384);
        let encoded: Buffer;
        for (;;) {
          if (
            end < value.length &&
            value.charCodeAt(end - 1) >= 0xd800 &&
            value.charCodeAt(end - 1) <= 0xdbff &&
            value.charCodeAt(end) >= 0xdc00 &&
            value.charCodeAt(end) <= 0xdfff
          )
            end--;
          encoded = Buffer.from(JSON.stringify(value.slice(offset, end)));
          if (encoded.length <= CHUNK_BYTES) break;
          end = offset + Math.floor((end - offset) / 2);
        }
        jsonBytes += encoded.length - 2;
        batch.push({
          key: key(chunks++),
          value: this.objects.put("chunk", encoded),
        });
        if (batch.length === 256) {
          root = this.tree.update(root, batch);
          batch.length = 0;
        }
        offset = end;
      }
      if (batch.length) root = this.tree.update(root, batch);
      const info: TextInfo = {
        kind: "text",
        version: 1,
        bytes: Buffer.byteLength(value),
        chars: value.length,
        jsonBytes,
        chunks,
        root,
      };
      return this.objects.put(
        "record",
        Buffer.from(JSON.stringify(info)),
        root ? [root] : [],
      );
    });
  }

  info(id: string): TextInfo {
    const stored = this.objects.get(id, "record");
    try {
      const value = JSON.parse(stored.bytes.toString()) as TextInfo;
      if (
        !value ||
        value.kind !== "text" ||
        value.version !== 1 ||
        ![value.bytes, value.chars, value.chunks, value.jsonBytes].every(
          Number.isSafeInteger,
        ) ||
        value.bytes < 0 ||
        value.bytes > MAX_TEXT_BYTES ||
        value.chars < 0 ||
        value.chars > MAX_TEXT_BYTES ||
        value.jsonBytes < 2 ||
        value.jsonBytes > MAX_TEXT_BYTES * 6 + 2 ||
        value.chunks < 0 ||
        value.chunks > MAX_TEXT_BYTES ||
        value.jsonBytes < value.bytes + 2 ||
        value.bytes < value.chars ||
        value.bytes > value.chars * 3 ||
        (value.chars === 0) !== (value.chunks === 0)
      )
        invalid();
      if (value.root !== null) assertObjectId(value.root);
      if (
        value.chunks === 0
          ? value.root !== null || value.bytes !== 0 || value.jsonBytes !== 2
          : !value.root || value.chunks > value.chars
      )
        invalid();
      if (
        stored.references.length !== (value.root ? 1 : 0) ||
        (value.root && stored.references[0] !== value.root)
      )
        invalid();
      if (this.tree.size(value.root) !== value.chunks) invalid();
      return value;
    } catch {
      return invalid();
    }
  }

  private chunk(info: TextInfo, index: number): string {
    const id = this.tree.get(info.root, key(index));
    if (!id) invalid();
    const stored = this.objects.get(id, "chunk");
    try {
      const value: unknown = JSON.parse(stored.bytes.toString());
      if (
        typeof value !== "string" ||
        stored.references.length ||
        Buffer.byteLength(value) > CHUNK_BYTES
      )
        invalid();
      return value;
    } catch {
      return invalid();
    }
  }

  page(id: string, cursor = 0): { text: string; next?: number } {
    const info = this.info(id);
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor >= Math.max(1, info.chunks)
    )
      throw new VersionStoreError(
        "VERSION_TEXT_CURSOR",
        "Invalid text chunk cursor.",
      );
    if (!info.chunks) return { text: "" };
    const text = this.chunk(info, cursor);
    return cursor + 1 < info.chunks ? { text, next: cursor + 1 } : { text };
  }

  read(id: string, maxBytes: number): string {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > MAX_TEXT_BYTES
    )
      throw new VersionStoreError(
        "VERSION_TEXT_BUDGET",
        "Invalid text materialization budget.",
      );
    const info = this.info(id);
    if (info.bytes > maxBytes)
      throw new VersionStoreError(
        "VERSION_TEXT_BUDGET",
        "Text exceeds materialization budget; request a content page.",
      );
    const chunks: string[] = [];
    let bytes = 0,
      chars = 0,
      jsonBytes = 2;
    for (let n = 0; n < info.chunks; n++) {
      const chunk = this.chunk(info, n);
      bytes += Buffer.byteLength(chunk);
      chars += chunk.length;
      jsonBytes += Buffer.byteLength(JSON.stringify(chunk)) - 2;
      if (bytes > maxBytes || chars > info.chars || jsonBytes > info.jsonBytes)
        invalid();
      chunks.push(chunk);
    }
    if (
      bytes !== info.bytes ||
      chars !== info.chars ||
      jsonBytes !== info.jsonBytes
    )
      invalid();
    return chunks.join("");
  }
}
