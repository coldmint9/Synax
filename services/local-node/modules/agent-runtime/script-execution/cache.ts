import { randomUUID } from "node:crypto";
import { runtimeBus } from "../runtime-bus.js";
import type { CachedScript, ScriptLanguage } from "./contracts.js";

interface ScriptCacheLimits {
  maxEntriesPerSession: number;
  maxBytes: number;
  ttlMs: number;
}

export const SCRIPT_CACHE_LIMITS: Readonly<ScriptCacheLimits> = Object.freeze({
  maxEntriesPerSession: 32,
  maxBytes: 8 * 1024 * 1024,
  ttlMs: 30 * 60 * 1000,
});

interface Entry {
  script: CachedScript;
  sessionId: string;
  bytes: number;
  expiresAt: number;
}

/** Bounded FIFO source storage. TTL is absolute (not refreshed by reads), lazily swept. */
export class SessionScriptCache {
  private readonly entries = new Map<string, Entry>();
  private readonly sessions = new Map<string, Set<string>>();
  private bytes = 0;
  private readonly limits: typeof SCRIPT_CACHE_LIMITS;

  constructor(limits: Partial<typeof SCRIPT_CACHE_LIMITS> = {}, private readonly now = Date.now) {
    this.limits = { ...SCRIPT_CACHE_LIMITS, ...limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Script cache limits must be positive safe integers.");
    }
  }

  private remove(scriptId: string): void {
    const entry = this.entries.get(scriptId);
    if (!entry) return;
    this.entries.delete(scriptId);
    this.bytes -= entry.bytes;
    const ids = this.sessions.get(entry.sessionId)!;
    ids.delete(scriptId);
    if (ids.size === 0) this.sessions.delete(entry.sessionId);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(id);
    }
  }

  rememberScript(sessionId: string, language: ScriptLanguage, source: string): CachedScript {
    if (typeof sessionId !== "string" || !sessionId.trim())
      throw new Error("A sessionId is required to cache script source.");
    if (!["sh", "python", "node"].includes(language) || typeof source !== "string")
      throw new Error("Script source and a supported language are required.");
    const script = Object.freeze({ scriptId: randomUUID(), language, source });
    // Include identities so even empty scripts and arbitrarily many sessions are bounded.
    const bytes = Buffer.byteLength(source) + Buffer.byteLength(sessionId)
      + Buffer.byteLength(script.scriptId) + Buffer.byteLength(language);
    if (bytes > this.limits.maxBytes)
      throw new Error(`Script source exceeds the ${this.limits.maxBytes}-byte cache limit.`);
    this.sweep();
    while ((this.sessions.get(sessionId)?.size ?? 0) >= this.limits.maxEntriesPerSession)
      this.remove(this.sessions.get(sessionId)!.values().next().value!);
    while (this.bytes + bytes > this.limits.maxBytes)
      this.remove(this.entries.keys().next().value!);
    const ids = this.sessions.get(sessionId) ?? new Set<string>();
    ids.add(script.scriptId);
    this.sessions.set(sessionId, ids);
    this.entries.set(script.scriptId, { script, sessionId, bytes, expiresAt: this.now() + this.limits.ttlMs });
    this.bytes += bytes;
    return script;
  }

  getScript(sessionId: string, scriptId: string): CachedScript {
    this.sweep();
    const entry = this.entries.get(scriptId);
    // Deliberately identical for missing, expired, evicted and another session's IDs.
    if (!entry || entry.sessionId !== sessionId)
      throw new Error("Script not found in this session (missing, expired or evicted); submit the source again.");
    return entry.script;
  }

  clearSessionScripts(sessionId: string): void {
    for (const id of this.sessions.get(sessionId) ?? []) this.remove(id);
  }
}

const cache = new SessionScriptCache();
// Session sources are process-local and never persisted. Drop them eagerly when
// the owning conversation is deleted or archived; TTL/size limits remain the
// fallback for worker crashes and sessions whose lifecycle event was missed.
runtimeBus.subscribe(event => {
  if (event.type === "session_deleted" || event.type === "session_archived")
    cache.clearSessionScripts(event.sessionId);
});
export const rememberScript = (sessionId: string, language: ScriptLanguage, source: string): CachedScript =>
  cache.rememberScript(sessionId, language, source);
export const getScript = (sessionId: string, scriptId: string): CachedScript => cache.getScript(sessionId, scriptId);
export const clearSessionScripts = (sessionId: string): void => cache.clearSessionScripts(sessionId);
