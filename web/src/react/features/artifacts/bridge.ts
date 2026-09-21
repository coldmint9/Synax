import type {
  ArtifactControl,
  ArtifactFeedbackInput,
  ArtifactState,
} from "../../../../../api/services/agent-runtime/artifacts/contracts";

export interface RuntimeConfig {
  protocol: 1;
  instanceId: string;
  revisionId: string;
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
    m.revisionId === config.revisionId &&
    typeof m.type === "string" &&
    m.type.length < 64 &&
    (m.requestId === undefined ||
      (typeof m.requestId === "string" && m.requestId.length <= 100))
  );
}
export function validateControlValue(
  control: ArtifactControl,
  value: unknown,
): boolean {
  if (control.type === "toggle") return typeof value === "boolean";
  if (control.type === "number" || control.type === "range")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (control.min === undefined || value >= control.min) &&
      (control.max === undefined || value <= control.max)
    );
  if (typeof value !== "string" || value.length > 2000) return false;
  if (control.type === "color") return /^#[\da-f]{6}$/i.test(value);
  return (
    control.type !== "select" ||
    !!control.options?.some((option) => option.value === value)
  );
}
export function validateControls(input: unknown): ArtifactControl[] {
  safeJson(input, 16384);
  if (!Array.isArray(input) || input.length > 12)
    throw new Error("At most 12 controls are allowed.");
  const keys = new Set<string>();
  for (const c of input) {
    if (
      !c ||
      typeof c !== "object" ||
      typeof c.key !== "string" ||
      !/^[a-zA-Z][\w-]{0,63}$/.test(c.key) ||
      forbidden.has(c.key) ||
      keys.has(c.key) ||
      typeof c.label !== "string" ||
      !c.label.trim() ||
      c.label.length > 120 ||
      !["select", "toggle", "range", "number", "color", "text"].includes(c.type)
    )
      throw new Error("Invalid artifact control.");
    keys.add(c.key);
    for (const key of ["min", "max", "step"])
      if (
        c[key] !== undefined &&
        (typeof c[key] !== "number" || !Number.isFinite(c[key]))
      )
        throw new Error("Invalid control bounds.");
    if (
      (c.min !== undefined && c.max !== undefined && c.min > c.max) ||
      (c.step !== undefined && c.step <= 0)
    )
      throw new Error("Invalid control range.");
    if (
      c.type === "select" &&
      (!Array.isArray(c.options) ||
        c.options.length < 1 ||
        c.options.length > 50 ||
        c.options.some(
          (o: any) =>
            !o ||
            typeof o.label !== "string" ||
            o.label.length > 120 ||
            typeof o.value !== "string" ||
            o.value.length > 2000,
        ))
    )
      throw new Error("Invalid control options.");
    if (!validateControlValue(c, c.defaultValue))
      throw new Error("Invalid control default.");
  }
  return safeJson(input) as ArtifactControl[];
}
export interface FeedbackDraft {
  text?: string;
  modelState?: unknown;
  element?: ArtifactFeedbackInput["element"];
}
export function feedbackInput(
  draft: FeedbackDraft,
  state: ArtifactState,
  idempotencyKey: string,
): ArtifactFeedbackInput {
  const result: ArtifactFeedbackInput = {
    text: typeof draft.text === "string" ? draft.text.slice(0, 8000) : "",
    parameters: state.controls,
    modelState:
      draft.modelState === undefined ? state.modelState : draft.modelState,
    idempotencyKey,
  };
  if (draft.element) {
    const e = draft.element;
    if (
      typeof e.tag !== "string" ||
      typeof e.text !== "string" ||
      (e.qaId !== undefined && typeof e.qaId !== "string")
    )
      throw new Error("Invalid element annotation.");
    result.element = {
      tag: e.tag.slice(0, 80),
      text: e.text.slice(0, 500),
      ...(e.qaId ? { qaId: e.qaId.slice(0, 120) } : {}),
    };
  }
  return safeJson(result);
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
export function validateState(input: unknown): ArtifactState {
  const state = safeJson(input, 16384) as ArtifactState;
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    !Object.prototype.hasOwnProperty.call(state, "privateState") ||
    !Object.prototype.hasOwnProperty.call(state, "modelState") ||
    !state.controls ||
    typeof state.controls !== "object" ||
    Array.isArray(state.controls) ||
    !Number.isSafeInteger(state.etag) ||
    state.etag < 0 ||
    !Number.isSafeInteger(state.schemaVersion) ||
    state.schemaVersion < 1
  )
    throw new Error("Saved artifact state is invalid.");
  return state;
}
