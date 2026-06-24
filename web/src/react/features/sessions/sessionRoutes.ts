export function sessionsPath(projectId: string): string {
  return `/projects/${projectId}/sessions`
}

export function newSessionPath(projectId: string): string {
  return `/projects/${projectId}/sessions/new`
}

export function sessionPath(projectId: string, sessionId: string): string {
  return `${sessionsPath(projectId)}?session=${encodeURIComponent(sessionId)}`
}

export function workflowSessionsPath(projectId: string): string {
  return `/projects/${projectId}/sessions/workflows`
}

export function isNewSessionPath(pathname: string): boolean {
  return pathname.endsWith('/sessions/new')
}

/** Session list without ?session= or /new /workflows suffix. */
export function isBareSessionsPath(pathname: string, projectId?: string): boolean {
  if (!pathname.endsWith('/sessions')) return false
  if (isNewSessionPath(pathname)) return false
  if (pathname.includes('/sessions/workflows')) return false
  if (projectId) return pathname === sessionsPath(projectId)
  return /\/projects\/[^/]+\/sessions$/.test(pathname)
}
