import {
  PAGE_BYTES,
  PAGE_ROWS,
  VersionStoreError,
} from "../version-store/limits.js";

export interface RuntimeWrite {
  /** Trusted repository-only copy of immutable field payloads. */
  copyFrom?: string;
  table: string;
  id: string;
  fields: Record<string, unknown>;
}
export const RUNTIME_BATCH_BYTES = PAGE_BYTES;

/** Count JSON bytes incrementally BEFORE copying/serializing the supplied graph.
 * Accessors and custom prototypes are rejected rather than executed. */
export function assertBatchInput(
  value: unknown,
  maxBytes = RUNTIME_BATCH_BYTES,
): number {
  let bytes = 0,
    nodes = 32768;
  const ancestors = new Set<object>();
  function charge(n: number): void {
    bytes += n;
    if (bytes > maxBytes)
      throw new VersionStoreError(
        "VERSION_BATCH_BUDGET",
        "Runtime batch exceeds its byte budget.",
      );
  }
  function string(text: string): void {
    if (text.length > maxBytes - bytes)
      throw new VersionStoreError(
        "VERSION_BATCH_BUDGET",
        "Runtime batch exceeds its byte budget.",
      );
    charge(2);
    for (let i = 0; i < text.length; ) {
      let end = Math.min(text.length, i + 8192);
      if (
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 &&
        text.charCodeAt(end) <= 0xdfff
      )
        end--;
      charge(Buffer.byteLength(JSON.stringify(text.slice(i, end))) - 2);
      i = end;
    }
  }
  function visit(input: unknown, depth: number): void {
    if (--nodes < 0 || depth > 32)
      throw new VersionStoreError(
        "VERSION_BATCH_BUDGET",
        "Runtime batch exceeds its node/depth limit.",
      );
    if (input === null || input === undefined) {
      charge(4);
      return;
    }
    if (typeof input === "string") {
      string(input);
      return;
    }
    if (typeof input === "boolean") {
      charge(input ? 4 : 5);
      return;
    }
    if (typeof input === "number") {
      charge(JSON.stringify(Number.isFinite(input) ? input : null).length);
      return;
    }
    if (typeof input !== "object")
      throw new VersionStoreError(
        "VERSION_BATCH_JSON",
        "Unsupported JSON batch value.",
      );
    if (input instanceof Date) {
      string(Date.prototype.toISOString.call(input));
      return;
    }
    if (ancestors.has(input))
      throw new VersionStoreError(
        "VERSION_BATCH_JSON",
        "Cyclic JSON batch is not supported.",
      );
    if (
      !Array.isArray(input) &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      throw new VersionStoreError(
        "VERSION_BATCH_JSON",
        "Unsupported JSON batch prototype.",
      );
    ancestors.add(input);
    charge(2);
    try {
      if (Array.isArray(input)) {
        if (input.length > nodes)
          throw new VersionStoreError(
            "VERSION_BATCH_BUDGET",
            "Runtime batch exceeds its node limit.",
          );
        for (let i = 0; i < input.length; i++) {
          if (i) charge(1);
          const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
          if (descriptor && !("value" in descriptor))
            throw new VersionStoreError(
              "VERSION_BATCH_JSON",
              "JSON accessors are not supported.",
            );
          visit(descriptor?.value, depth + 1);
        }
      } else {
        let count = 0;
        for (const name in input) {
          if (!Object.hasOwn(input, name)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(input, name)!;
          if (!("value" in descriptor))
            throw new VersionStoreError(
              "VERSION_BATCH_JSON",
              "JSON accessors are not supported.",
            );
          if (descriptor.value === undefined) continue;
          if (count++) charge(1);
          string(name);
          charge(1);
          visit(descriptor.value, depth + 1);
        }
      }
    } finally {
      ancestors.delete(input);
    }
  }
  visit(value, 0);
  return bytes;
}

export function assertRuntimeBatch(writes: readonly RuntimeWrite[]): void {
  if (!Array.isArray(writes) || writes.length > PAGE_ROWS)
    throw new VersionStoreError(
      "VERSION_BATCH_LIMIT",
      "Runtime batch row limit exceeded.",
    );
  assertBatchInput(writes);
  for (const write of writes) {
    if (
      !write ||
      typeof write.table !== "string" ||
      typeof write.id !== "string" ||
      !write.id.length ||
      Buffer.byteLength(write.id) > 256 ||
      !write.id.isWellFormed() ||
      !write.fields ||
      Array.isArray(write.fields)
    )
      throw new VersionStoreError(
        "VERSION_BATCH_JSON",
        "Invalid runtime batch row identity/fields.",
      );
  }
}
