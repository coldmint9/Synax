import { useCallback, useEffect, useState } from 'react'
import { projectSettingsApi } from '../../adapters/transport/project-settings'
import { fetchStaleResource, readStaleResource, writeStaleResource } from '../../shared/lib/staleResource'
import type { ProjectSettings, UpdateProjectSettingsRequest } from '../../shared/contracts/project-settings'

export function useProjectSettings(projectId: string) {
  const cacheKey = `project-settings:${projectId}`
  const [settings, setSettings] = useState<ProjectSettings | null>(() =>
    readStaleResource<ProjectSettings>(cacheKey) ?? null,
  )
  const [loading, setLoading] = useState(() =>
    readStaleResource<ProjectSettings>(cacheKey) === undefined,
  )
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const cached = readStaleResource<ProjectSettings>(cacheKey)
    setSettings(cached ?? null)
    setLoading(cached === undefined)
    setError(null)
    try {
      const resp = await fetchStaleResource(cacheKey, async () => (await projectSettingsApi.get(projectId)).settings)
      writeStaleResource(cacheKey, resp)
      setSettings(resp)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load project settings')
    } finally {
      setLoading(false)
    }
  }, [projectId, cacheKey])

  useEffect(() => {
    void load()
  }, [load])

  const update = useCallback(async (patch: UpdateProjectSettingsRequest) => {
    const resp = await projectSettingsApi.update(projectId, patch)
    writeStaleResource(cacheKey, resp.settings)
    setSettings(resp.settings)
    return resp.settings
  }, [projectId, cacheKey])

  const patchSection = useCallback(async (section: string, data: unknown) => {
    const resp = await projectSettingsApi.patchSection(projectId, section, data)
    writeStaleResource(cacheKey, resp.settings)
    setSettings(resp.settings)
    return resp.settings
  }, [projectId, cacheKey])

  const archive = useCallback(async (justification: string) => {
    const auth = { confirmPhrase: 'CONFIRM', securityCode: '000000', justification }
    const resp = await projectSettingsApi.archive(projectId, auth)
    writeStaleResource(cacheKey, resp.settings)
    setSettings(resp.settings)
  }, [projectId, cacheKey])

  const restore = useCallback(async (justification: string) => {
    const auth = { confirmPhrase: 'CONFIRM', securityCode: '000000', justification }
    const resp = await projectSettingsApi.restore(projectId, auth)
    writeStaleResource(cacheKey, resp.settings)
    setSettings(resp.settings)
  }, [projectId, cacheKey])

  const transfer = useCallback(async (newOwnerMemberId: string, justification: string) => {
    const auth = { confirmPhrase: 'CONFIRM', securityCode: '000000', justification }
    const resp = await projectSettingsApi.transfer(projectId, newOwnerMemberId, auth)
    writeStaleResource(cacheKey, resp.settings)
    setSettings(resp.settings)
  }, [projectId, cacheKey])

  const reset = useCallback(async () => {
    await projectSettingsApi.reset(projectId)
    await load()
  }, [projectId, load])

  return {
    settings,
    loading,
    error,
    reload: load,
    update,
    patchSection,
    archive,
    restore,
    transfer,
    reset,
  }
}
