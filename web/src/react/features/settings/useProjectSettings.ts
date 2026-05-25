import { useCallback, useEffect, useState } from 'react'
import { projectSettingsApi } from '../../../lib/api/project-settings'
import type { ProjectSettings, UpdateProjectSettingsRequest } from '../../../lib/contracts/project-settings'

export function useProjectSettings(projectId: string) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await projectSettingsApi.get(projectId)
      setSettings(resp.settings)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load project settings')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const update = useCallback(async (patch: UpdateProjectSettingsRequest) => {
    const resp = await projectSettingsApi.update(projectId, patch)
    setSettings(resp.settings)
    return resp.settings
  }, [projectId])

  const patchSection = useCallback(async (section: string, data: unknown) => {
    const resp = await projectSettingsApi.patchSection(projectId, section, data)
    setSettings(resp.settings)
    return resp.settings
  }, [projectId])

  const archive = useCallback(async (justification: string) => {
    const auth = { confirmPhrase: 'CONFIRM', securityCode: '000000', justification }
    const resp = await projectSettingsApi.archive(projectId, auth)
    setSettings(resp.settings)
  }, [projectId])

  const restore = useCallback(async (justification: string) => {
    const auth = { confirmPhrase: 'CONFIRM', securityCode: '000000', justification }
    const resp = await projectSettingsApi.restore(projectId, auth)
    setSettings(resp.settings)
  }, [projectId])

  const transfer = useCallback(async (newOwnerMemberId: string, justification: string) => {
    const auth = { confirmPhrase: 'CONFIRM', securityCode: '000000', justification }
    const resp = await projectSettingsApi.transfer(projectId, newOwnerMemberId, auth)
    setSettings(resp.settings)
  }, [projectId])

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
