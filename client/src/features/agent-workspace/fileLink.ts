export interface FileLinkTarget {
  /** Workspace-relative path, `/` separated. */
  path: string;
  /** 1-based line from a `#L12` anchor or a `path:12` suffix. */
  line: number | null;
  rootId?: string;
  rootName?: string;
}

export interface FileLinkRoot {
  rootId: string;
  name: string;
  workspacePath: string;
}

/**
 * Session scope that turns a record's file target into a viewer tab.
 *
 * Resolution stays with the caller: a record row shows a link affordance only
 * when the scope can actually open the path.
 */
export interface ToolFileLinks {
  resolve: (raw: string) => FileLinkTarget | null;
  open: (target: FileLinkTarget) => void;
}

/** Any `scheme:` prefix, used to reject http/mailto/vscode style links. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const DRIVE_PATH = /^[a-zA-Z]:\//;
/**
 * A real file name: a dot somewhere after the first character, or a dotfile.
 * Dots may appear anywhere in the last segment (`animation.v2.html`), but the
 * segment stays free of `/`, so nested paths survive the check.
 */
const FILE_SEGMENT = /^[^/]*\.[^/]+/;
const TRAILING_LINE = /^(.*?):(\d+)(?::\d+)?$/;
const FRAGMENT_LINE = /^L?(\d+)/i;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fragmentLine(fragment: string): number | null {
  const match = FRAGMENT_LINE.exec(fragment.replace(/^#/, ""));
  return match ? Number(match[1]) : null;
}

function normalizePath(value: string): string | null {
  const path = value.replace(/\\/g, "/");
  const prefix = DRIVE_PATH.test(path)
    ? path.slice(0, 3)
    : path.startsWith("/") ? "/" : "";
  const segments: string[] = [];
  for (const segment of path.slice(prefix.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length || segments[segments.length - 1] === "..") {
        if (prefix) return null;
        segments.push(segment);
      } else segments.pop();
    } else segments.push(segment);
  }
  return prefix + segments.join("/");
}

/** Map an absolute path into the session workspace; anything outside is unreadable. */
function toWorkspaceRelative(
  value: string,
  workspacePath?: string | null,
): string | null {
  if (!value.startsWith("/") && !DRIVE_PATH.test(value)) return value;
  const root = workspacePath
    ? normalizePath(workspacePath)?.replace(/\/+$/, "")
    : "";
  if (!root || value === root) return null;
  return value.startsWith(`${root}/`) ? value.slice(root.length + 1) : null;
}

function parseCandidate(
  candidate: string,
  workspacePath?: string | null,
  roots: readonly FileLinkRoot[] = [],
): FileLinkTarget | null {
  if (!candidate) return null;

  let value = candidate.trim();
  if (/^file:/i.test(value)) {
    // `file:///abs/path` and `file:/abs/path` both denote a local absolute path.
    value = value.replace(/^file:\/\/+/i, "/").replace(/^file:/i, "");
  } else if (
    SCHEME.test(value) &&
    !/^[a-zA-Z]:[\\/]/.test(value) &&
    !TRAILING_LINE.test(value)
  ) {
    return null;
  }

  const hashIndex = value.indexOf("#");
  const fragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : "";
  if (hashIndex >= 0) value = value.slice(0, hashIndex);
  const queryIndex = value.indexOf("?");
  if (queryIndex >= 0) value = value.slice(0, queryIndex);

  value = decode(value).replace(/\\/g, "/").trim();
  if (!value || value === ".") return null;
  if (value.startsWith("./")) value = value.slice(2);

  const match = TRAILING_LINE.exec(value);
  const pathPart = match?.[1] ? match[1] : value;
  const inlineLine = match?.[1] ? Number(match[2]) : null;

  // A filename followed by a line number looks like a URL scheme. Only
  // allow that colon after removing the numeric suffix, never a real URL.
  if (SCHEME.test(pathPart) && !DRIVE_PATH.test(pathPart)) return null;

  // Agents can cite reference projects relative to the primary checkout (for
  // example ../settlement/src/Mapper.xml). Resolve dot segments first, then
  // check membership against every registered root instead of losing the path.
  const absolute = pathPart.startsWith("/") || DRIVE_PATH.test(pathPart);
  const hasParentSegments = pathPart.split("/").includes("..");
  if (!absolute && hasParentSegments && !workspacePath) return null;
  const resolved = normalizePath(
    !absolute && hasParentSegments ? `${workspacePath}/${pathPart}` : pathPart,
  );
  if (!resolved) return null;
  const root = [...roots]
    .sort((a, b) => b.workspacePath.length - a.workspacePath.length)
    .find((entry) => {
      const base = normalizePath(entry.workspacePath)?.replace(/\/+$/, "");
      return base && resolved.startsWith(`${base}/`);
    });
  const relative = toWorkspaceRelative(
    resolved,
    root?.workspacePath ?? workspacePath,
  );
  if (!relative) return null;

  const segments = relative.split("/");
  if (
    !segments.every((segment) => segment && segment !== "." && segment !== "..")
  )
    return null;
  if (!FILE_SEGMENT.test(segments[segments.length - 1])) return null;

  return {
    path: relative,
    line: inlineLine ?? (fragment ? fragmentLine(fragment) : null),
    ...(root ? { rootId: root.rootId, rootName: root.name } : {}),
  };
}

/**
 * Resolve a markdown link into a workspace file the viewer can open.
 *
 * Handles the shapes agents actually emit — `[src/a.ts](src/a.ts)`,
 * `[src/a.ts:12](src/a.ts#L12)`, `[a.ts](file:///repo/src/a.ts#L12)` — and
 * returns null for external links so ordinary URLs keep their default anchor
 * behaviour instead of being captured as files.
 */
export function parseFileLink(
  href: string | undefined,
  label: string | undefined,
  workspacePath?: string | null,
  roots: readonly FileLinkRoot[] = [],
): FileLinkTarget | null {
  const raw = (href ?? "").trim();
  // An explicit destination is authoritative. Falling back to its shortened
  // display label silently turns a rejected path into a different file.
  if (raw) return parseCandidate(raw, workspacePath, roots);
  return parseCandidate((label ?? "").trim(), workspacePath, roots);
}

/**
 * Walk a relative path against the folder that contains `documentPath`.
 *
 * Documents link to their neighbours (`./baseline.md`) far more often than to
 * repository-root paths, so their own folder is the reference point. Walking
 * above the repository root is rejected instead of being normalized away.
 */
export function resolveDocumentRelativePath(
  value: string,
  documentPath?: string | null,
): string | null {
  const parts = (documentPath ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .slice(0, -1)
    .filter(Boolean);
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/**
 * Outcome of a link written inside a rendered workspace document.
 *
 * `external` keeps the browser's own behaviour (http, mail or an in-page
 * anchor); `file` is a workspace target the viewer can open; `unresolved` is a
 * link the app must intercept anyway, because letting it fall through navigates
 * the whole window to a path the runtime cannot serve.
 */
export type DocumentLink =
  | { kind: "external" }
  | { kind: "file"; target: FileLinkTarget }
  | { kind: "unresolved" };

/** Only these schemes leave the app; anything else is not a web destination. */
const EXTERNAL_SCHEME = /^(?:https?|mailto|tel|data|blob|javascript|ftp):/i;

/**
 * Resolve a link inside a workspace document.
 *
 * `[基线](./baseline.md)` in `docs/plan.md` points at `docs/baseline.md`, and
 * `[a](../src/a.ts#L12)` walks out of the document's folder. Absolute paths and
 * `file:` URIs stay unresolved: the renderer only knows the document's
 * repository-relative path, so it cannot map a host path to a workspace one.
 */
export function resolveDocumentLink(
  href: string | undefined,
  documentPath?: string | null,
  rootId?: string,
): DocumentLink {
  const raw = (href ?? "").trim();
  // An in-page anchor is navigation the reader still expects to work.
  if (!raw || raw.startsWith("#")) return { kind: "external" };
  if (raw.startsWith("//") || EXTERNAL_SCHEME.test(raw))
    return { kind: "external" };

  const match = TRAILING_LINE.exec(raw);
  let value = match?.[1] ? match[1] : raw;
  const inlineLine = match?.[1] ? Number(match[2]) : null;
  if (
    /^file:/i.test(value) ||
    value.startsWith("/") ||
    DRIVE_PATH.test(value)
  )
    return { kind: "unresolved" };
  if (SCHEME.test(value)) return { kind: "external" };

  const hashIndex = value.indexOf("#");
  const fragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : "";
  if (hashIndex >= 0) value = value.slice(0, hashIndex);
  const queryIndex = value.indexOf("?");
  if (queryIndex >= 0) value = value.slice(0, queryIndex);

  const cleaned = decode(value).replace(/\\/g, "/").trim();
  if (!cleaned || cleaned === ".") return { kind: "unresolved" };
  const path = resolveDocumentRelativePath(cleaned, documentPath);
  if (
    !path ||
    !path
      .split("/")
      .every((segment) => segment && segment !== "." && segment !== "..")
  )
    return { kind: "unresolved" };

  return {
    kind: "file",
    target: {
      path,
      line: inlineLine ?? (fragment ? fragmentLine(fragment) : null),
      ...(rootId ? { rootId } : {}),
    },
  };
}
