// ---------------------------------------------------------------------------
// web/src/react/features/settings/useConfig.ts — 统一配置 Hook
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import { fetchStaleResource, readStaleResource, writeStaleResource } from '../../shared/lib/staleResource'
import { configApi } from '../../adapters/transport/config'
import type {
  GlobalConfig,
  ProjectConfig,
  ProviderDef,
  EffectiveConfig,
} from '../../shared/contracts/config'

type ConfigSnapshot = {
  globalConfig: GlobalConfig | null
  projectConfig: ProjectConfig | null
  effectiveConfig: EffectiveConfig | null
  providers: ProviderDef[]
}

export function useConfig(projectId?: string | null) {
  const cacheKey = `config:${projectId ?? 'global'}`
  const cached = readStaleResource<ConfigSnapshot>(cacheKey)
  const [globalConfig, setGlobalConfig] = useState<GlobalConfig | null>(() => cached?.globalConfig ?? null)
  const [projectConfig, setProjectConfig] = useState<ProjectConfig | null>(() => cached?.projectConfig ?? null)
  const [effectiveConfig, setEffectiveConfig] = useState<EffectiveConfig | null>(() => cached?.effectiveConfig ?? null)
  const [providers, setProviders] = useState<ProviderDef[]>(() => cached?.providers ?? [])
  const [loading, setLoading] = useState(() => cached === undefined)

  const load = useCallback(async () => {
    const cached = readStaleResource<ConfigSnapshot>(cacheKey)
    if (cached) {
      setGlobalConfig(cached.globalConfig)
      setProjectConfig(cached.projectConfig)
      setEffectiveConfig(cached.effectiveConfig)
      setProviders(cached.providers)
    }
    setLoading(cached === undefined)
    try {
      const next = await fetchStaleResource(cacheKey, async () => {
        const [global, provList] = await Promise.all([
          configApi.getGlobal(),
          configApi.listProviders(),
        ])
        if (!projectId) {
          return {
            globalConfig: global.config,
            projectConfig: null,
            effectiveConfig: null,
            providers: provList.providers,
          }
        }
        const [proj, eff] = await Promise.all([
          configApi.getProject(projectId),
          configApi.getEffective(projectId),
        ])
        return {
          globalConfig: global.config,
          projectConfig: proj.config,
          effectiveConfig: eff.config,
          providers: provList.providers,
        }
      })
      writeStaleResource(cacheKey, next)
      setGlobalConfig(next.globalConfig)
      setProjectConfig(next.projectConfig)
      setEffectiveConfig(next.effectiveConfig)
      setProviders(next.providers)
    } catch (err) {
      console.error('[useConfig] load failed', err)
      if (!projectId) {
        setProjectConfig(null)
        setEffectiveConfig(null)
      }
    } finally {
      setLoading(false)
    }
  }, [cacheKey, projectId])

  useEffect(() => {
    void load()
  }, [load])

  const updateProjectConfig = useCallback(
    async (patch: Parameters<typeof configApi.updateProject>[1]) => {
      if (!projectId) return
      const res = await configApi.updateProject(projectId, patch)
      setProjectConfig(res.config)
      const current = readStaleResource<ConfigSnapshot>(cacheKey)
      writeStaleResource(cacheKey, { globalConfig: current?.globalConfig ?? globalConfig, projectConfig: res.config, effectiveConfig: current?.effectiveConfig ?? effectiveConfig, providers: current?.providers ?? providers })
    },
    [cacheKey, effectiveConfig, globalConfig, projectId, providers],
  )

  const updateGlobalConfig = useCallback(
    async (patch: Parameters<typeof configApi.updateGlobal>[0]) => {
      const res = await configApi.updateGlobal(patch)
      setGlobalConfig(res.config)
      const current = readStaleResource<ConfigSnapshot>(cacheKey)
      writeStaleResource(cacheKey, { globalConfig: res.config, projectConfig: current?.projectConfig ?? projectConfig, effectiveConfig: current?.effectiveConfig ?? effectiveConfig, providers: current?.providers ?? providers })
    },
    [cacheKey, effectiveConfig, projectConfig, providers],
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
