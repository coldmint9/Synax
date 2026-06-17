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
