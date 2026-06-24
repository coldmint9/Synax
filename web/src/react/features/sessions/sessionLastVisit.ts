import {
  sessionPath,
  sessionsPath,
  newSessionPath,
} from './sessionRoutes'

const STORAGE_KEY = 'synax.sessionLastVisit'

export type SessionLastVisit =
  | { kind: 'new' }
  | { kind: 'session'; sessionId: string }

function storageKey(projectId: string): string {
  return `${STORAGE_KEY}:${projectId}`
}

export function loadSessionLastVisit(projectId: string): SessionLastVisit | null {
  if (!projectId || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as SessionLastVisit
    if (parsed.kind === 'new') return { kind: 'new' }
    if (parsed.kind === 'session' && typeof parsed.sessionId === 'string' && parsed.sessionId) {
      return { kind: 'session', sessionId: parsed.sessionId }
    }
  } catch {
    return null
  }
  return null
}

export function saveSessionLastVisit(projectId: string, visit: SessionLastVisit): void {
  if (!projectId || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(visit))
  } catch { /* quota */ }
}

export function clearSessionLastVisit(projectId: string): void {
  if (!projectId || typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(storageKey(projectId))
  } catch { /* ignore */ }
}

export function sessionLastVisitPath(projectId: string, visit: SessionLastVisit): string {
  if (visit.kind === 'new') return newSessionPath(projectId)
  return sessionPath(projectId, visit.sessionId)
}

/** Default sessions tab target — last visit or bare list. */
export function resolveSessionsEntryPath(projectId: string): string {
  const last = loadSessionLastVisit(projectId)
  if (!last) return sessionsPath(projectId)
  return sessionLastVisitPath(projectId, last)
}
