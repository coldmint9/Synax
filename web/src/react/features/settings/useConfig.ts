// ---------------------------------------------------------------------------
// web/src/react/features/settings/useConfig.ts — 统一配置 Hook
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import { configApi } from '../../../lib/api/config'
import type {
  GlobalConfig,
  ProjectConfig,
  ProviderDef,
  EffectiveConfig,
} from '../../../lib/contracts/config'

export function useConfig(projectId?: string | null) {
  const [globalConfig, setGlobalConfig] = useState<GlobalConfig | null>(null)
  const [projectConfig, setProjectConfig] = useState<ProjectConfig | null>(null)
  const [effectiveConfig, setEffectiveConfig] = useState<EffectiveConfig | null>(null)
  const [providers, setProviders] = useState<ProviderDef[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [global, provList] = await Promise.all([
        configApi.getGlobal(),
        configApi.listProviders(),
      ])
      setGlobalConfig(global.config)
      setProviders(provList.providers)

      if (projectId) {
        const [proj, eff] = await Promise.all([
          configApi.getProject(projectId),
          configApi.getEffective(projectId),
        ])
        setProjectConfig(proj.config)
        setEffectiveConfig(eff.config)
      } else {
        setProjectConfig(null)
        setEffectiveConfig(null)
      }
    } catch (err) {
      console.error('[useConfig] load failed', err)
      if (!projectId) {
        setProjectConfig(null)
        setEffectiveConfig(null)
      }
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const updateProjectConfig = useCallback(
    async (patch: Parameters<typeof configApi.updateProject>[1]) => {
      if (!projectId) return
      await configApi.updateProject(projectId, patch)
      await load()
    },
    [projectId, load],
  )

  const updateGlobalConfig = useCallback(
    async (patch: Parameters<typeof configApi.updateGlobal>[0]) => {
      await configApi.updateGlobal(patch)
      await load()
    },
    [load],
  )

  const resetProjectConfig = useCallback(async () => {
    if (!projectId) return
    await configApi.deleteProject(projectId)
    await load()
  }, [projectId, load])

  return {
    globalConfig,
    projectConfig,
    effectiveConfig,
    providers,
    llmProviders: providers,
    loading,
    reload: load,
    updateGlobalConfig,
    updateProjectConfig,
    resetProjectConfig,
  }
}
