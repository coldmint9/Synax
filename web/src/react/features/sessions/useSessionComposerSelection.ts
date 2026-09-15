import { useCallback } from 'react'
import { create } from 'zustand'
import type { AgentSession, BackendId, ReasoningEffort } from '../../../lib/api/agentRuntime'
import type { EffectiveConfig, GlobalConfig, ProviderDef } from '../../../lib/contracts/config'
import { buildGoalModelOptions, pickDefaultSelection } from '../wiki/goal/goalModelOptions'
import { useAgentSessionStore } from './agentSessionStore'
import { useWikiStore } from '../../state/wikiStore'
import { sessionRuntimeSelection } from './sessionRuntimeSelection'

interface Selection {
  providerId: string | null
  modelId: string | null
  cliModel: string
  reasoningEffort: ReasoningEffort
}

// Outside the component so route/layout remounts retain unsent choices as well.
export const useSessionComposerSelections = create<{
  selections: Record<string, Partial<Selection>>
  patch: (key: string, patch: Partial<Selection>) => void
}>((set) => ({
  selections: {},
  patch: (key, patch) => set(state => ({
    selections: { ...state.selections, [key]: { ...state.selections[key], ...patch } },
  })),
}))

export function useSessionComposerSelection(
  projectId: string, session: AgentSession | undefined, backendId: BackendId,
  globalConfig: GlobalConfig | null, providers: ProviderDef[], effectiveConfig: EffectiveConfig | null,
) {
  const key = JSON.stringify([projectId, session?.id ?? null, backendId])
  const saved = useSessionComposerSelections(s => s.selections[key])
  const patch = useSessionComposerSelections(s => s.patch)
  const runs = useAgentSessionStore(s => session?.id === s.selectedSessionId ? s.runs : s.sessionDetailCache[session?.id ?? '']?.runs)
  const steps = useAgentSessionStore(s => session?.id === s.selectedSessionId ? s.steps : s.sessionDetailCache[session?.id ?? '']?.steps)
  const runtime = sessionRuntimeSelection(session, runs ?? [], steps ?? [])
  const draftProvider = useWikiStore(s => s.goalComposerProviderId)
  const draftModel = useWikiStore(s => s.goalComposerModelId)
  const draftEffort = useWikiStore(s => s.goalComposerReasoningEffort)
  const { apiModels } = buildGoalModelOptions(globalConfig, providers)
  const preferred = effectiveConfig ? { providerId: effectiveConfig.providerId, modelId: effectiveConfig.modelId } : null
  const defaultSelection = pickDefaultSelection(apiModels, [], preferred)
  const matchingModel = apiModels.find(item => item.modelId === runtime.model && item.providerId === effectiveConfig?.providerId)
    ?? apiModels.find(item => item.modelId === runtime.model)
  const native = backendId === 'native'
  const model = runtime.model
  const initial: Selection = {
    providerId: native
      ? (session ? matchingModel?.providerId ?? defaultSelection?.providerId ?? null : draftProvider ?? defaultSelection?.providerId ?? null)
      : backendId,
    modelId: native
      ? (session ? model ?? defaultSelection?.modelId ?? null : draftModel ?? defaultSelection?.modelId ?? null)
      : model?.startsWith(`${backendId}/`) ? model.slice(backendId.length + 1) : model ?? 'default',
    cliModel: model ?? 'default',
    reasoningEffort: runtime.reasoningEffort ?? (session ? 'high' : draftEffort),
  }
  const selection = { ...initial, ...saved }
  const setSelection = useCallback((value: Partial<Selection>) => patch(key, value), [key, patch])
  return { ...selection, setSelection }
}
