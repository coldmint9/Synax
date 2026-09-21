import type {
  ArtifactBounds,
  ArtifactCreate,
  ArtifactRect,
  ArtifactUpdate,
} from "./types.js";

export const ARTIFACT_SCHEME = "synax-artifact";
export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_ACTIVE = 2;
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-scripts",
].join("; ");
export function fail(code = "POLICY_BLOCKED"): never {
  throw new Error(code);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
}
export function parseId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value))
    return fail();
  return value;
}
function rect(value: unknown): ArtifactRect {
  const v = object(value);
  for (const key of ["x", "y", "width", "height"]) {
    const n = v[key];
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      Math.abs(n) > 16384 ||
      ((key === "width" || key === "height") && n < 0)
    )
      fail();
  }
  return {
    x: v.x as number,
    y: v.y as number,
    width: v.width as number,
    height: v.height as number,
  };
}
function bounds(value: unknown): ArtifactBounds {
  const v = object(value);
  return {
    ...rect(v),
    ...(v.clip === undefined ? {} : { clip: rect(v.clip) }),
  };
}
export function parseCreate(value: unknown): ArtifactCreate {
  const v = object(value);
  if (
    typeof v.html !== "string" ||
    !v.html.length ||
    Buffer.byteLength(v.html) > MAX_BUNDLE_BYTES
  )
    return fail("RESOURCE_LIMIT");
  if (typeof v.nonce !== "string" || !/^[A-Za-z0-9_-]{16,160}$/.test(v.nonce))
    return fail();
  return {
    id: parseId(v.id),
    html: v.html,
    revisionId: parseId(v.revisionId),
    nonce: v.nonce,
    bounds: bounds(v.bounds),
  };
}
export function parseUpdate(value: unknown): ArtifactUpdate {
  const v = object(value);
  if (typeof v.visible !== "boolean") return fail();
  return { id: parseId(v.id), bounds: bounds(v.bounds), visible: v.visible };
}
export function safeMessage(value: unknown): Record<string, unknown> {
  object(value);
  let nodes = 0;
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 24) fail("RESOURCE_LIMIT");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object") fail();
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null)
      fail();
    for (const [key, child] of Object.entries(item as object)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail();
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_MESSAGE_BYTES) fail("RESOURCE_LIMIT");
  return JSON.parse(json) as Record<string, unknown>;
}
export function assertOwner(
  event: { sender: unknown; senderFrame: unknown },
  owner: { webContents: { mainFrame: unknown }; isDestroyed(): boolean } | null,
): void {
  if (
    !owner ||
    owner.isDestroyed() ||
    event.sender !== owner.webContents ||
    event.senderFrame !== owner.webContents.mainFrame
  )
    fail();
}
export function allowBundleRequest(
  request: {
    url: string;
    method: string;
    resourceType: string;
    webContentsId?: number;
  },
  url: string,
  contentsId: number,
  loaded: boolean,
): boolean {
  return (
    !loaded &&
    request.url === url &&
    request.method === "GET" &&
    request.resourceType === "mainFrame" &&
    request.webContentsId === contentsId
  );
}
/** Bounds in DIP, inward-rounded so native surfaces never extend over host UI. */
export function clipBounds(
  b: ArtifactBounds,
  viewportWidth: number,
  viewportHeight: number,
  zoom: number,
): { outer: ArtifactRect; inner: ArtifactRect } | null {
  if (!Number.isFinite(zoom) || zoom <= 0 || zoom > 5) return null;
  const x = Math.floor(b.x * zoom),
    y = Math.floor(b.y * zoom);
  const right = Math.floor((b.x + b.width) * zoom),
    bottom = Math.floor((b.y + b.height) * zoom);
  const c = b.clip;
  const left = Math.ceil(Math.max(0, b.x * zoom, c ? c.x * zoom : 0));
  const top = Math.ceil(Math.max(0, b.y * zoom, c ? c.y * zoom : 0));
  const r = Math.floor(
    Math.min(viewportWidth, right, c ? (c.x + c.width) * zoom : viewportWidth),
  );
  const bot = Math.floor(
    Math.min(
      viewportHeight,
      bottom,
      c ? (c.y + c.height) * zoom : viewportHeight,
    ),
  );
  if (r <= left || bot <= top) return null;
  return {
    outer: { x: left, y: top, width: r - left, height: bot - top },
    inner: { x: x - left, y: y - top, width: right - x, height: bottom - y },
  };
}
export class RateLimit {
  private tokens = 40;
  constructor(private at = Date.now()) {}
  take(now = Date.now()): boolean {
    this.tokens = Math.min(40, this.tokens + Math.max(0, now - this.at) * 0.02);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

export const RUNTIME_MESSAGE_TYPES = new Set([
  "hello",
  "ready",
  "state",
  "resize",
  "controls",
  "feedbackDraft",
  "element",
  "log",
]);
export const HOST_MESSAGE_TYPES = new Set([
  "connect",
  "response",
  "theme",
  "stateChanged",
  "controlsChanged",
  "pick",
]);
export function validateEnvelope(
  message: Record<string, unknown>,
  identity: { id: string; nonce: string; revisionId: string },
  direction: "host" | "runtime",
): void {
  if (
    message.protocol !== 1 ||
    message.instanceId !== identity.id ||
    message.nonce !== identity.nonce ||
    message.revisionId !== identity.revisionId
  )
    fail();
  if (
    typeof message.type !== "string" ||
    !(direction === "host" ? HOST_MESSAGE_TYPES : RUNTIME_MESSAGE_TYPES).has(
      message.type,
    )
  )
    fail();
  if (
    message.requestId !== undefined &&
    (typeof message.requestId !== "string" || message.requestId.length > 160)
  )
    fail();
}

/** Only the actual app document (or explicitly configured local dev server) owns views. */
export function isTrustedHostURL(
  raw: string,
  developmentOrigin?: string,
): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    return (
      (url.protocol === "app:" && url.hostname === "." && !url.port) ||
      (!!developmentOrigin && url.origin === developmentOrigin)
    );
  } catch {
    return false;
  }
}
