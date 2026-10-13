import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendTranscript, readTranscript, type TranscriptRecord } from "../transcript-jsonl.js";

const roots: string[] = [];
const record = (text: string): TranscriptRecord => ({
  hash: createHash("sha256").update(text).digest("hex"),
  kind: "message",
  payload: Buffer.from(text),
  references: [],
});
function root() { const value = mkdtempSync(path.join(os.tmpdir(), "synax-transcript-")); roots.push(value); return value; }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe("durable JSONL transcript", () => {
  it("appends, reads and truncates an uncommitted tail", () => {
    const dir = root(); const first = appendTranscript(dir, "session-1", 0, record("one"));
    writeFileSync(path.join(dir, "transcripts", "session-1.jsonl"), Buffer.concat([readFileSync(path.join(dir, "transcripts", "session-1.jsonl")), Buffer.from("garbage")]));
    const second = appendTranscript(dir, "session-1", first.length, record("two"));
    expect(readTranscript(dir, "session-1", first.offset, first.length).payload.toString()).toBe("one");
    expect(readTranscript(dir, "session-1", second.offset, second.length).payload.toString()).toBe("two");
  });
  it("rejects missing committed bytes and corrupted records", () => {
    const dir = root();
    expect(() => appendTranscript(dir, "session-1", 4, record("one"))).toThrow("TRANSCRIPT_MISSING_TAIL");
    const location = appendTranscript(dir, "session-1", 0, record("one"));
    const file = path.join(dir, "transcripts", "session-1.jsonl"); const bytes = readFileSync(file); bytes[bytes.length - 3] = bytes[bytes.length - 3] === 48 ? 49 : 48; writeFileSync(file, bytes);
    expect(() => readTranscript(dir, "session-1", location.offset, location.length)).toThrow("TRANSCRIPT_CHECKSUM");
  });
  it("bounds segments and payloads", () => {
    const dir = root(); expect(() => appendTranscript(dir, "../escape", 0, record("x"))).toThrow("TRANSCRIPT_SEGMENT");
    expect(() => appendTranscript(dir, "s", 0, { ...record("x"), payload: Buffer.alloc(64 * 1024 + 1) })).toThrow("TRANSCRIPT_PAYLOAD_SIZE");
  });
});
