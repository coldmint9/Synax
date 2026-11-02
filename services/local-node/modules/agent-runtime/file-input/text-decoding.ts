/**
 * Plain-text detection and decoding for attached files.
 *
 * A character file stays readable even when this runtime did not write it:
 * Chinese Windows editors still export GB18030 (GBK) text, log captures carry
 * ANSI escape sequences, and a file copied through a byte budget can end inside
 * a multi-byte character. Each of those used to surface as "不支持二进制文件";
 * only content that really is binary should.
 */
export interface CharacterDecodeOptions {
  /** Declared MIME type, when the caller knows it. */
  mediaType?: string;
  /** Filename, used to recognize text formats by extension. */
  filename?: string;
}

/** Media types that always describe text. */
const TEXT_MEDIA_TYPE =
  /^(?:text\/|application\/(?:json|xml|x-ndjson|ld\+json|javascript|ecmascript|yaml|x-yaml|toml|sql|graphql|rtf))/i;

/** Extensions that users and tools present as text. */
const TEXT_EXTENSION =
  /\.(?:txt|text|log|md|markdown|csv|tsv|json|jsonl|ndjson|xml|ya?ml|toml|ini|conf|cfg|env|properties|sql|diff|patch|srt|vtt|rst|tex|html?|css|scss|less|jsx?|tsx?|vue|svelte|py|rb|go|rs|java|kt|kts|cs|c|h|cc|cpp|hpp|swift|php|sh|bash|zsh|fish|bat|cmd|ps1|gradle|lua|pl|r|dart|ex|exs|erl|hs|clj|scala|groovy)$/i;

/**
 * The legacy encoding Windows and older Chinese office tools still emit.
 * GB18030 is a strict superset of GBK/GB2312, so one decoder covers them all.
 * Big5, Shift-JIS and EUC-KR are deliberately absent: byte-pair encodings
 * decode "successfully" as each other, and a wrong guess would feed mojibake
 * to the model instead of telling the user to re-save the file.
 */
const LEGACY_ENCODINGS = ["gb18030"] as const;

/** C0 controls that never belong to saved text; NUL is handled separately. */
const BINARY_CONTROL = /[\u0001-\u0008\u000b\u000e-\u001f\u007f]/;
/** ANSI/VT escape sequences left behind by terminal and log captures. */
const ANSI_ESCAPE =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/** Code points a decoder emits for bytes it could not map to real text. */
const IMPLAUSIBLE = /[\ue000-\uf8ff\ufffd\ufffe\uffff]/g;

/** True when the declared type or the filename describes text. */
export function looksLikeTextFile(
  options?: CharacterDecodeOptions,
): boolean {
  if (!options) return false;
  return (
    Boolean(
      options.mediaType && TEXT_MEDIA_TYPE.test(options.mediaType.trim()),
    ) ||
    Boolean(options.filename && TEXT_EXTENSION.test(options.filename.trim()))
  );
}

function normalizeCharacterText(text: string): string | undefined {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const readable = body.includes("\u001b")
    ? body.replace(ANSI_ESCAPE, "").replaceAll("\u001b", "")
    : body;
  if (readable.includes("\u0000") || BINARY_CONTROL.test(readable))
    return undefined;
  return readable;
}

function decodeStrict(
  bytes: Uint8Array,
  encoding: string,
): string | undefined {
  try {
    return normalizeCharacterText(
      new TextDecoder(encoding, { fatal: true }).decode(bytes),
    );
  } catch {
    return undefined;
  }
}

/** The valid prefix of a file whose last multi-byte character was cut off. */
function withoutIncompleteUtf8Tail(bytes: Uint8Array): Uint8Array | undefined {
  for (let start = Math.max(0, bytes.length - 3); start < bytes.length; start++) {
    const lead = bytes[start]!;
    if (lead < 0xc2 || lead > 0xf4) continue;
    const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
    if (bytes.length - start >= needed) continue;
    if (bytes.subarray(start + 1).every((byte) => (byte & 0xc0) === 0x80))
      return bytes.subarray(0, start);
  }
  return undefined;
}

function plausibleLegacyText(text: string): boolean {
  const implausible = text.match(IMPLAUSIBLE)?.length ?? 0;
  return implausible === 0 || implausible / text.length <= 0.02;
}

function decodeLegacy(bytes: Uint8Array, encoding: string): string | undefined {
  const full = decodeStrict(bytes, encoding);
  if (full !== undefined) return full;
  // A file cut inside a double-byte character still carries readable text.
  return bytes.length > 1
    ? decodeStrict(bytes.subarray(0, bytes.length - 1), encoding)
    : undefined;
}

/**
 * Decode a character file, or return undefined when the bytes are binary.
 * Legacy encodings are only attempted for inputs that claim to be text, so an
 * unknown binary payload is never reinterpreted as CJK characters.
 */
export function decodeCharacterFile(
  bytes: Uint8Array,
  options?: CharacterDecodeOptions,
): string | undefined {
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : undefined;
  if (utf16) return decodeStrict(bytes, utf16);
  const utf8 = decodeStrict(bytes, "utf-8");
  if (utf8 !== undefined) return utf8;
  // A file cut inside a multi-byte character is still text: keep its valid prefix.
  const prefix = withoutIncompleteUtf8Tail(bytes);
  const repaired = prefix ? decodeStrict(prefix, "utf-8") : undefined;
  if (repaired !== undefined) return repaired;
  if (!looksLikeTextFile(options)) return undefined;
  for (const encoding of LEGACY_ENCODINGS) {
    const text = decodeLegacy(bytes, encoding);
    if (text !== undefined && plausibleLegacyText(text)) return text;
  }
  return undefined;
}
