import { apiFetch } from './origin'

/** One navigable child directory on the runtime host. */
export interface RemoteDirectoryEntry {
  name: string
  path: string
  hidden: boolean
}

/** Response of `GET /api/fs/list`. */
export interface RemoteDirectoryListing {
  path: string
  name: string
  parent: string | null
  home: string
  shortcuts: string[]
  entries: RemoteDirectoryEntry[]
  truncated: boolean
}

export interface ListDirectoryOptions {
  /** Include dot-directories. */
  showHidden?: boolean
  /** Include build/VCS directories such as `node_modules` or `dist`. */
  showIgnored?: boolean
  signal?: AbortSignal
  locationKind?: 'host' | 'wsl'
  distribution?: string
}

/**
 * List child directories of `path` on the runtime host.
 *
 * The browser build cannot read a local absolute path from the renderer, so the
 * host enumerates directories on the user's behalf and the selected absolute
 * path is sent back to `/api/projects`. Only directory names are exposed; file
 * contents never cross this endpoint.
 */
export async function listRemoteDirectories(
  path?: string,
  options: ListDirectoryOptions = {},
): Promise<RemoteDirectoryListing> {
  const query = new URLSearchParams()
  if (path) query.set('path', path)
  if (options.locationKind) query.set('locationKind', options.locationKind)
  if (options.distribution) query.set('distribution', options.distribution)
  if (options.showHidden) query.set('showHidden', '1')
  if (options.showIgnored) query.set('showIgnored', '1')
  const suffix = query.toString()

  const resp = await apiFetch(`/api/fs/list${suffix ? `?${suffix}` : ''}`, { signal: options.signal })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ error: resp.statusText })) as { error?: string }
    throw new Error(body.error || `HTTP ${resp.status}`)
  }
  return resp.json() as Promise<RemoteDirectoryListing>
}
