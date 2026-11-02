import { describe, expect, it } from "vitest";
import { clearSessionScripts, getScript, rememberScript, SessionScriptCache } from "./cache.js";

describe("session script source cache", () => {
  it("stores frozen source-only records, without authority or mutable revisions", () => {
    const cache = new SessionScriptCache();
    const first = cache.rememberScript("a", "sh", "printf first");
    const second = cache.rememberScript("a", "sh", "printf second");
    expect(Object.keys(first).sort()).toEqual(["language", "scriptId", "source"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => Object.assign(first, { source: "changed", approved: true })).toThrow();
    expect(cache.getScript("a", first.scriptId)).toEqual(first);
    expect(first.scriptId).not.toBe(second.scriptId);
    expect(cache.getScript("a", first.scriptId).source).toBe("printf first");
  });

  it("never resolves across sessions and does not reveal whether an ID exists", () => {
    const cache = new SessionScriptCache();
    const script = cache.rememberScript("a", "python", "print(1)");
    const errorFor = (id: string) => {
      try { cache.getScript("b", id); } catch (error) { return (error as Error).message; }
    };
    expect(errorFor(script.scriptId)).toBe(errorFor("unknown"));
    expect(() => cache.getScript("b", script.scriptId)).toThrow(/not found in this session/);
    expect(cache.getScript("a", script.scriptId)).toEqual(script);
  });

  it("evicts oldest entries per session without touching another session", () => {
    const cache = new SessionScriptCache({ maxEntriesPerSession: 2 });
    const other = cache.rememberScript("b", "node", "");
    const oldest = cache.rememberScript("a", "sh", "1");
    const kept = cache.rememberScript("a", "sh", "2");
    cache.getScript("a", oldest.scriptId); // reads do not refresh FIFO/TTL
    cache.rememberScript("a", "sh", "3");
    expect(() => cache.getScript("a", oldest.scriptId)).toThrow(/evicted/);
    expect(cache.getScript("a", kept.scriptId)).toEqual(kept);
    expect(cache.getScript("b", other.scriptId)).toEqual(other);
  });

  it("bounds global UTF-8 bytes and evicts across sessions", () => {
    // UUID(36) + session(1) + language(4) + source(9) = 50 bytes each.
    const cache = new SessionScriptCache({ maxBytes: 100 });
    const first = cache.rememberScript("a", "node", "中文文");
    const second = cache.rememberScript("b", "node", "中文文");
    const third = cache.rememberScript("c", "node", "中文文");
    expect(() => cache.getScript("a", first.scriptId)).toThrow();
    expect(cache.getScript("b", second.scriptId)).toEqual(second);
    expect(cache.getScript("c", third.scriptId)).toEqual(third);
    expect(() => cache.rememberScript("d", "node", "文".repeat(34))).toThrow(/byte cache limit/);
    expect(cache.getScript("b", second.scriptId)).toEqual(second); // rejected insert is non-destructive
  });

  it("expires at the absolute TTL boundary even after a successful read", () => {
    let now = 0;
    const cache = new SessionScriptCache({ ttlMs: 100 }, () => now);
    const script = cache.rememberScript("a", "node", "");
    now = 99;
    expect(cache.getScript("a", script.scriptId)).toEqual(script);
    now = 100;
    expect(() => cache.getScript("a", script.scriptId)).toThrow(/expired/);
  });

  it("clearing a session releases its byte budget and leaves other sessions intact", () => {
    const cache = new SessionScriptCache({ maxBytes: 100 });
    const a = cache.rememberScript("a", "node", "中文文");
    const b = cache.rememberScript("b", "node", "中文文");
    cache.clearSessionScripts("a");
    cache.clearSessionScripts("a");
    cache.rememberScript("c", "node", "中文文");
    expect(() => cache.getScript("a", a.scriptId)).toThrow();
    expect(cache.getScript("b", b.scriptId)).toEqual(b);
  });

  it("exports session lifecycle methods and accepts all three languages", () => {
    for (const language of ["sh", "python", "node"] as const) {
      const value = rememberScript("cache-export-test", language, "source");
      expect(getScript("cache-export-test", value.scriptId)).toEqual(value);
      clearSessionScripts("cache-export-test");
      expect(() => getScript("cache-export-test", value.scriptId)).toThrow();
    }
  });

  it("rejects invalid bounds and anonymous cache entries", () => {
    expect(() => new SessionScriptCache({ ttlMs: 0 })).toThrow();
    expect(() => new SessionScriptCache({ maxBytes: Infinity })).toThrow();
    expect(() => new SessionScriptCache().rememberScript("", "node", "")).toThrow(/sessionId/);
  });
});
