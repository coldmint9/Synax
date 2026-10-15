import { useCallback, useEffect, useState } from 'react'
import { aiIntegrationApi } from '../../adapters/transport/ai-integration'
import type { AgentApiBinding, AiIntegration } from '../../shared/contracts/ai-integration'
import { fetchStaleResource, readStaleResource, writeStaleResource } from '../../shared/lib/staleResource'

export function useAiIntegrations() {
  const cacheKey = 'ai-integrations'
  const cached = readStaleResource<{ integrations: AiIntegration[]; bindings: AgentApiBinding[] }>(cacheKey)
  const [integrations, setIntegrations] = useState<AiIntegration[]>(() => cached?.integrations ?? [])
  const [bindings, setBindings] = useState<AgentApiBinding[]>(() => cached?.bindings ?? [])
  const [loading, setLoading] = useState(() => cached === undefined)

  const load = useCallback(async () => {
    const cached = readStaleResource<{ integrations: AiIntegration[]; bindings: AgentApiBinding[] }>(cacheKey)
    if (cached) {
      setIntegrations(cached.integrations)
      setBindings(cached.bindings)
    }
    setLoading(cached === undefined)
    const next = await fetchStaleResource(cacheKey, async () => {
      const [ints, binds] = await Promise.all([
        aiIntegrationApi.list(),
        aiIntegrationApi.listBindings(),
      ])
      return { integrations: ints.items, bindings: binds.items }
    })
    writeStaleResource(cacheKey, next)
    setIntegrations(next.integrations)
    setBindings(next.bindings)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return {
    integrations,
    bindings,
    loading,
    reload: load,
  }
}
