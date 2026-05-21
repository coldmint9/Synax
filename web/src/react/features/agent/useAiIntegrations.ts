import { useCallback, useEffect, useState } from 'react'
import { aiIntegrationApi } from '../../../lib/api/ai-integration'
import type { AgentApiBinding, AiIntegration } from '../../../lib/contracts/ai-integration'

export function useAiIntegrations() {
  const [integrations, setIntegrations] = useState<AiIntegration[]>([])
  const [bindings, setBindings] = useState<AgentApiBinding[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [ints, binds] = await Promise.all([
      aiIntegrationApi.list(),
      aiIntegrationApi.listBindings(),
    ])
    setIntegrations(ints.items)
    setBindings(binds.items)
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
