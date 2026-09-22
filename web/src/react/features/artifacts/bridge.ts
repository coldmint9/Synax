export interface RuntimeConfig {
  protocol: 1;
  instanceId: string;
  prototypeId: string;
  nonce: string;
  transport?: "web" | "desktop";
}
export interface Envelope extends RuntimeConfig {
  type: string;
  requestId?: string;
  payload?: unknown;
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function safeJson<T>(value: T, limit = 32768): T {
  const seen = new Set<object>();
  let nodes = 0;
  function visit(v: unknown, depth: number): void {
    if (++nodes > 4096 || depth > 24)
      throw new Error("Artifact data is too deeply nested.");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || seen.has(v))
      throw new Error("Artifact data must be finite, acyclic JSON.");
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null)
      throw new Error("Artifact data must be plain JSON.");
    seen.add(v);
    for (const key of Object.keys(v)) {
      if (forbidden.has(key)) throw new Error("Unsafe artifact data key.");
      visit((v as Record<string, unknown>)[key], depth + 1);
    }
    seen.delete(v);
  }
  visit(value, 0);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > limit)
    throw new Error(`Artifact data exceeds ${limit} bytes.`);
  return JSON.parse(json) as T;
}
export function acceptsEnvelope(
  data: unknown,
  config: RuntimeConfig,
  source?: unknown,
  expectedSource?: unknown,
): data is Envelope {
  if (source !== expectedSource) return false;
  try {
    safeJson(data);
  } catch {
    return false;
  }
  if (!data || typeof data !== "object") return false;
  const m = data as Envelope;
  return (
    m.protocol === 1 &&
    m.nonce === config.nonce &&
    m.instanceId === config.instanceId &&
    m.prototypeId === config.prototypeId &&
    typeof m.type === "string" &&
    m.type.length < 64 &&
    (m.requestId === undefined ||
      (typeof m.requestId === "string" && m.requestId.length <= 100))
  );
}
export function injectRuntimeConfig(
  html: string,
  config: RuntimeConfig,
): string {
  if (!/<head(?:\s[^>]*)?>/i.test(html))
    throw new Error("Artifact bundle is missing its compiler-owned head.");
  const content = JSON.stringify(config)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  return html.replace(
    /<head(?:\s[^>]*)?>/i,
    (head) =>
      `${head}<meta name="synax-artifact-runtime" content="${content}">`,
  );
}
export class MessageBudget {
  private tokens = 40;
  private last: number | undefined;
  take(now = performance.now()): boolean {
    if (this.last !== undefined)
      this.tokens = Math.min(
        40,
        this.tokens + Math.max(0, now - this.last) / 50,
      );
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export function runtimeId(): string {
  // randomUUID is restricted to secure contexts; getRandomValues also supports
  // explicitly opted-in LAN Web deployments. Never fall back to Math.random.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
