export interface FileLinkTarget {
  /** Workspace-relative path, `/` separated. */
  path: string
  /** 1-based line from a `#L12` anchor or a `path:12` suffix. */
  line: number | null
}

/** Any `scheme:` prefix, used to reject http/mailto/vscode style links. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const DRIVE_PATH = /^[a-zA-Z]:\//
/**
 * A real file name: a dot somewhere after the first character, or a dotfile.
 * Dots may appear anywhere in the last segment (`animation.v2.html`), but the
 * segment stays free of `/`, so nested paths survive the check.
 */
const FILE_SEGMENT = /^[^/]*\.[^/]+/
const TRAILING_LINE = /^(.*?):(\d+)(?::\d+)?$/
const FRAGMENT_LINE = /^L?(\d+)/i

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function fragmentLine(fragment: string): number | null {
  const match = FRAGMENT_LINE.exec(fragment.replace(/^#/, ''))
  return match ? Number(match[1]) : null
}

/** Map an absolute path into the session workspace; anything outside is unreadable. */
function toWorkspaceRelative(value: string, workspacePath?: string | null): string | null {
  if (!value.startsWith('/')) return DRIVE_PATH.test(value) ? null : value
  const root = workspacePath ? workspacePath.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  if (!root || value === root) return null
  return value.startsWith(`${root}/`) ? value.slice(root.length + 1) : null
}

function parseCandidate(candidate: string, workspacePath?: string | null): FileLinkTarget | null {
  if (!candidate) return null

  let value = candidate.trim()
  if (/^file:/i.test(value)) {
    // `file:///abs/path` and `file:/abs/path` both denote a local absolute path.
    value = value.replace(/^file:\/\/+/i, '/').replace(/^file:/i, '')
  } else if (SCHEME.test(value)) {
    return null
  }

  const hashIndex = value.indexOf('#')
  const fragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : ''
  if (hashIndex >= 0) value = value.slice(0, hashIndex)
  const queryIndex = value.indexOf('?')
  if (queryIndex >= 0) value = value.slice(0, queryIndex)

  value = decode(value).replace(/\\/g, '/').trim()
  if (!value || value === '.') return null
  if (value.startsWith('./')) value = value.slice(2)

  const match = TRAILING_LINE.exec(value)
  const pathPart = match?.[1] ? match[1] : value
  const inlineLine = match?.[1] ? Number(match[2]) : null

  const relative = toWorkspaceRelative(pathPart, workspacePath)
  if (!relative) return null

  const segments = relative.split('/')
  if (!segments.every(segment => segment && segment !== '.' && segment !== '..')) return null
  if (!FILE_SEGMENT.test(segments[segments.length - 1])) return null

  return { path: relative, line: inlineLine ?? (fragment ? fragmentLine(fragment) : null) }
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
): FileLinkTarget | null {
  const raw = (href ?? '').trim()
  if (raw) {
    const target = parseCandidate(raw, workspacePath)
    if (target) return target
    // A real URL (or a scheme we cannot read) is never re-interpreted as a path.
    if (SCHEME.test(raw) && !/^file:/i.test(raw)) return null
  }
  return parseCandidate((label ?? '').trim(), workspacePath)
}
