import { create } from 'zustand'

export type AgentViewMode = 'sessions' | 'skills'

interface SkillStoreState {
  agentViewMode: AgentViewMode
  setAgentViewMode: (mode: AgentViewMode) => void
}

export const useSkillStore = create<SkillStoreState>((set) => ({
  agentViewMode: 'sessions',
  setAgentViewMode: (agentViewMode) => set({ agentViewMode }),
}))
