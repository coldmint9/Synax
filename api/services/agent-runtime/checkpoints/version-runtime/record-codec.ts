import { VersionObjects } from "../version-store/objects.js";
import { VersionText, MAX_TEXT_BYTES } from "../version-store/text.js";
import { VersionStoreError, assertObjectId } from "../version-store/limits.js";
import { atomicVersionWrite } from "../version-store/transaction.js";

const METADATA_BYTES = 1024 * 1024;
const INLINE_BYTES = 1024;
type Value =
  | null
  | boolean
  | number
  | string
  | Value[]
  | { [key: string]: Value };
type Field =
  | { inline: Value }
  | {
      ref: string;
      encoding: "text" | "json";
      bytes: number;
      jsonBytes: number;
    };
export interface RecordHeader {
  kind: "runtime-record";
  version: 1;
  table: string;
  scope: string;
  id: string;
  order: number;
  fields: Record<string, Field>;
  jsonBytes: number;
}
function identity(value: string): void {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    !value.isWellFormed() ||
    Buffer.byteLength(value) > 256
  )
    throw new VersionStoreError(
      "VERSION_RECORD_ID",
      "Invalid runtime record identity.",
    );
}

/** Preflight traverses at most 10k values / depth 32 and never JSON.stringify's
 * an unbounded object first. Accessors/custom toJSON are not invoked implicitly. */
function normalized(input: unknown): Value | undefined {
  let remaining = METADATA_BYTES,
    nodes = 10000;
  const path = new Set<object>();
  function charge(bytes: number) {
    remaining -= bytes;
    if (remaining < 0)
      throw new VersionStoreError(
        "VERSION_RECORD_BUDGET",
        "JSON metadata exceeds its byte budget.",
      );
  }
  function string(value: string): string {
    if (value.length > remaining) charge(value.length);
    // Small windows bound escaping/allocation even for a huge malicious field.
    charge(2);
    for (let n = 0; n < value.length; ) {
      let end = Math.min(n + 8192, value.length);
      if (
        end < value.length &&
        value.charCodeAt(end - 1) >= 0xd800 &&
        value.charCodeAt(end - 1) <= 0xdbff &&
        value.charCodeAt(end) >= 0xdc00 &&
        value.charCodeAt(end) <= 0xdfff
      )
        end--;
      charge(Buffer.byteLength(JSON.stringify(value.slice(n, end))) - 2);
      n = end;
    }
    return value;
  }
  function walk(value: unknown, depth: number): Value | undefined {
    if (--nodes < 0 || depth > 32)
      throw new VersionStoreError(
        "VERSION_RECORD_BUDGET",
        "JSON metadata exceeds its node/depth limit.",
      );
    if (value === undefined) return undefined;
    if (value === null) {
      charge(4);
      return null;
    }
    if (typeof value === "string") return string(value);
    if (typeof value === "number") {
      const result = Number.isFinite(value) ? value : null;
      charge(JSON.stringify(result).length);
      return result;
    }
    if (typeof value === "boolean") {
      charge(value ? 4 : 5);
      return value;
    }
    if (typeof value !== "object")
      throw new VersionStoreError(
        "VERSION_RECORD_JSON",
        "Unsupported JSON value.",
      );
    if (value instanceof Date) return walk(value.toJSON(), depth + 1);
    if (path.has(value))
      throw new VersionStoreError(
        "VERSION_RECORD_JSON",
        "Cyclic JSON metadata is not supported.",
      );
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new VersionStoreError(
        "VERSION_RECORD_JSON",
        "Unsupported JSON object prototype.",
      );
    path.add(value);
    charge(2);
    try {
      if (Array.isArray(value)) {
        if (value.length > nodes)
          throw new VersionStoreError(
            "VERSION_RECORD_BUDGET",
            "JSON metadata exceeds its node limit.",
          );
        return Array.from({ length: value.length }, (_, i) => {
          charge(1);
          return walk(value[i], depth + 1) ?? null;
        });
      }
      const result: Record<string, Value> = Object.create(null);
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor))
          throw new VersionStoreError(
            "VERSION_RECORD_JSON",
            "JSON accessors are not supported.",
          );
        if (descriptor.value === undefined) continue;
        string(key);
        charge(2);
        result[key] = walk(descriptor.value, depth + 1)!;
      }
      return result;
    } finally {
      path.delete(value);
    }
  }
  return walk(input, 0);
}

export class RuntimeRecordCodec {
  readonly text: VersionText;
  constructor(private readonly objects: VersionObjects) {
    this.text = new VersionText(objects);
  }

  write(
    table: string,
    scope: string,
    id: string,
    order: number,
    fields: Record<string, unknown>,
  ): string {
    for (const value of [table, scope, id]) identity(value);
    if (!Number.isSafeInteger(order) || order < 0)
      throw new VersionStoreError(
        "VERSION_RECORD_ORDER",
        "Invalid record order.",
      );
    return atomicVersionWrite(this.objects.db, () => {
      const descriptors: Record<string, Field> = Object.create(null),
        references: string[] = [];
      let count = 0,
        jsonBytes = 2;
      for (const name in fields) {
        if (!Object.hasOwn(fields, name)) continue;
        identity(name);
        if (++count > 64)
          throw new VersionStoreError(
            "VERSION_RECORD_FIELDS",
            "Record field limit exceeded.",
          );
        const property = Object.getOwnPropertyDescriptor(fields, name)!;
        if (!("value" in property))
          throw new VersionStoreError(
            "VERSION_RECORD_JSON",
            "Record accessors are not supported.",
          );
        const input = property.value;
        if (input === undefined) continue;
        let descriptor: Field, size: number;
        if (typeof input === "string" && input.length > INLINE_BYTES / 6) {
          const ref = this.text.write(input),
            info = this.text.info(ref);
          descriptor = {
            ref,
            encoding: "text",
            bytes: info.bytes,
            jsonBytes: info.jsonBytes,
          };
          references.push(ref);
          size = info.jsonBytes;
        } else {
          const value = normalized(input);
          if (value === undefined) continue;
          const encoded = JSON.stringify(value);
          size = Buffer.byteLength(encoded);
          if (size > INLINE_BYTES) {
            const ref = this.text.write(encoded);
            descriptor = {
              ref,
              encoding: "json",
              bytes: Buffer.byteLength(encoded),
              jsonBytes: size,
            };
            references.push(ref);
          } else descriptor = { inline: value };
        }
        jsonBytes +=
          Buffer.byteLength(JSON.stringify(name)) +
          1 +
          size +
          (Object.keys(descriptors).length ? 1 : 0);
        if (jsonBytes > MAX_TEXT_BYTES * 2)
          throw new VersionStoreError(
            "VERSION_RECORD_BUDGET",
            "Record exceeds its aggregate byte budget.",
          );
        descriptors[name] = descriptor;
      }
      const header: RecordHeader = {
        kind: "runtime-record",
        version: 1,
        table,
        scope,
        id,
        order,
        fields: descriptors,
        jsonBytes,
      };
      return this.objects.put(
        "record",
        Buffer.from(JSON.stringify(header)),
        references,
      );
    });
  }

  header(id: string): RecordHeader {
    const stored = this.objects.get(id, "record");
    try {
      const header = JSON.parse(stored.bytes.toString()) as RecordHeader;
      if (
        header.kind !== "runtime-record" ||
        header.version !== 1 ||
        !Number.isSafeInteger(header.order) ||
        header.order < 0 ||
        !header.fields ||
        Array.isArray(header.fields)
      )
        throw new Error();
      for (const v of [header.table, header.scope, header.id]) identity(v);
      const entries = Object.entries(header.fields);
      if (entries.length > 64) throw new Error();
      const refs: string[] = [];
      let bytes = 2;
      for (const [name, field] of entries) {
        identity(name);
        let size: number;
        if (field && Object.hasOwn(field, "inline")) {
          const encoded = JSON.stringify((field as { inline: Value }).inline);
          size = Buffer.byteLength(encoded);
          if (size > INLINE_BYTES) throw new Error();
        } else {
          const value = field as Exclude<Field, { inline: Value }>;
          assertObjectId(value.ref);
          if (
            !["text", "json"].includes(value.encoding) ||
            !Number.isSafeInteger(value.bytes) ||
            value.bytes < 0 ||
            value.bytes > MAX_TEXT_BYTES ||
            !Number.isSafeInteger(value.jsonBytes) ||
            value.jsonBytes < 0
          )
            throw new Error();
          refs.push(value.ref);
          size = value.jsonBytes;
        }
        bytes += Buffer.byteLength(JSON.stringify(name)) + 1 + size;
      }
      if (entries.length) bytes += entries.length - 1;
      if (bytes !== header.jsonBytes || bytes > MAX_TEXT_BYTES * 2)
        throw new Error();
      const unique = [...new Set(refs)].sort();
      if (
        unique.length !== stored.references.length ||
        unique.some((ref, i) => ref !== stored.references[i])
      )
        throw new Error();
      return header;
    } catch {
      throw new VersionStoreError(
        "VERSION_RECORD_CORRUPT",
        "Runtime record integrity check failed.",
      );
    }
  }

  read(
    id: string,
    maxBytes: number,
    projection?: readonly string[],
  ): Record<string, unknown> {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 2 ||
      maxBytes > MAX_TEXT_BYTES * 2
    )
      throw new VersionStoreError(
        "VERSION_RECORD_BUDGET",
        "Invalid record materialization budget.",
      );
    const header = this.header(id),
      selected = projection ? new Set(projection) : null;
    if (projection && projection.length > 64)
      throw new VersionStoreError(
        "VERSION_RECORD_BUDGET",
        "Projection field limit exceeded.",
      );
    const entries = Object.entries(header.fields).filter(
      ([name]) => !selected || selected.has(name),
    );
    const size =
      2 +
      Math.max(0, entries.length - 1) +
      entries.reduce(
        (n, [name, f]) =>
          n +
          Buffer.byteLength(JSON.stringify(name)) +
          1 +
          ("inline" in f
            ? Buffer.byteLength(JSON.stringify(f.inline))
            : f.jsonBytes),
        0,
      );
    if (size > maxBytes)
      throw new VersionStoreError(
        "VERSION_RECORD_BUDGET",
        "Record exceeds materialization budget; request a projection/content page.",
      );
    const result: Record<string, unknown> = Object.create(null);
    for (const [name, f] of entries) {
      if ("inline" in f) result[name] = f.inline;
      else {
        const info = this.text.info(f.ref);
        if (
          info.bytes !== f.bytes ||
          (f.encoding === "text" && info.jsonBytes !== f.jsonBytes) ||
          (f.encoding === "json" && f.bytes !== f.jsonBytes)
        )
          throw new VersionStoreError(
            "VERSION_RECORD_CORRUPT",
            "Runtime field size integrity check failed.",
          );
        const value = this.text.read(f.ref, Math.min(maxBytes, MAX_TEXT_BYTES));
        result[name] = f.encoding === "text" ? value : JSON.parse(value);
      }
    }
    return result;
  }
}
