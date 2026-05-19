import type { AgentSession } from '../../../lib/api/agentRuntime'

export interface SessionGroup {
  key: string
  label: string
  icon: string
  isBuiltin: boolean
  sessions: SessionTreeNode[]
}

export interface SessionTreeNode {
  session: AgentSession
  children: SessionTreeNode[]
}

const PROFILE_CATEGORY: Record<string, { group: string; icon: string; isBuiltin: boolean }> = {
  'wiki-planner': { group: 'Wiki Agent', icon: 'BookOpen', isBuiltin: true },
  'wiki-writer': { group: 'Wiki Agent', icon: 'BookOpen', isBuiltin: true },
  'wiki-explorer': { group: 'Wiki Agent', icon: 'BookOpen', isBuiltin: true },
  'wiki-generator': { group: 'Wiki Agent', icon: 'BookOpen', isBuiltin: true },
  explorer: { group: 'General', icon: 'Compass', isBuiltin: false },
  reviewer: { group: 'General', icon: 'ClipboardCheck', isBuiltin: false },
}

const DEFAULT_CATEGORY = { group: 'Other', icon: 'Bot', isBuiltin: false }

export function getSessionCategory(profileId: string) {
  return PROFILE_CATEGORY[profileId] ?? DEFAULT_CATEGORY
}

export function buildSessionTree(
  parent: AgentSession,
  allSessions: AgentSession[],
): SessionTreeNode {
  const children = allSessions
    .filter(s => s.parentSessionId === parent.id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map(child => buildSessionTree(child, allSessions))
  return { session: parent, children }
}

export function groupSessions(sessions: AgentSession[]): SessionGroup[] {
  const topLevel = sessions.filter(s => !s.parentSessionId)
  const groupMap = new Map<string, SessionGroup>()

  for (const session of topLevel) {
    const cat = getSessionCategory(session.profileId)
    if (!groupMap.has(cat.group)) {
      groupMap.set(cat.group, {
        key: cat.group,
        label: cat.group,
        icon: cat.icon,
        isBuiltin: cat.isBuiltin,
        sessions: [],
      })
    }
    groupMap.get(cat.group)!.sessions.push(buildSessionTree(session, sessions))
  }

  return [...groupMap.values()].sort((a, b) => {
    if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}
