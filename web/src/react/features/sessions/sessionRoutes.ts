export function goalSessionsPath(projectId: string): string {
  return `/projects/${projectId}/sessions`
}

export function newGoalSessionPath(projectId: string): string {
  return `/projects/${projectId}/sessions/new`
}

export function goalSessionPath(projectId: string, sessionId: string): string {
  return `${goalSessionsPath(projectId)}?session=${encodeURIComponent(sessionId)}`
}

export function workflowSessionsPath(projectId: string): string {
  return `/projects/${projectId}/sessions/workflows`
}

export function isNewGoalSessionPath(pathname: string): boolean {
  return pathname.endsWith('/sessions/new')
}

/** Goal session list without ?session= or /new /workflows suffix. */
export function isBareGoalSessionsPath(pathname: string, projectId?: string): boolean {
  if (!pathname.endsWith('/sessions')) return false
  if (isNewGoalSessionPath(pathname)) return false
  if (pathname.includes('/sessions/workflows')) return false
  if (projectId) return pathname === goalSessionsPath(projectId)
  return /\/projects\/[^/]+\/sessions$/.test(pathname)
}
