import { useCallback, useEffect, useState } from 'react'
import { projectSettingsApi } from '../../../lib/api/project-settings'
import type { ProjectSettings } from '../../../lib/contracts/project-settings'
import { teamApi } from '../../../lib/api/team'
import { useShellStore } from '../../state/shellStore'

function authEnvelope() {
  return {
    confirmPhrase: 'CONFIRM',
    securityCode: '000000',
    justification: 'Prototype operation',
  }
}

export function useProjectSettings(projectId: string) {
  const currentUser = useShellStore(s => s.currentUser)
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [memberOptions, setMemberOptions] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [settingsResp, membersResp] = await Promise.all([
        projectSettingsApi.get(projectId),
        teamApi.listMembersAndRoles(),
      ])
      setSettings(settingsResp.settings)
      setMemberOptions(membersResp.members.map(m => ({ id: m.id, name: m.name })))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load project settings')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const update = useCallback(async (next: ProjectSettings) => {
    const resp = await projectSettingsApi.update(projectId, {
      basics: next.basics,
      collaboration: next.collaboration,
      notifications: next.notifications,
      compliance: next.compliance,
    }, currentUser.name)
    setSettings(resp.settings)
  }, [projectId, currentUser.name])

  const archive = useCallback(async () => {
    const resp = await projectSettingsApi.archive(projectId, { auth: authEnvelope() }, currentUser.id, currentUser.name)
    setSettings(resp.settings)
  }, [projectId, currentUser.id, currentUser.name])

  const restore = useCallback(async () => {
    const resp = await projectSettingsApi.restore(projectId, { auth: authEnvelope() }, currentUser.id, currentUser.name)
    setSettings(resp.settings)
  }, [projectId, currentUser.id, currentUser.name])

  const transfer = useCallback(async (newOwnerMemberId: string) => {
    const resp = await projectSettingsApi.transfer(
      projectId,
      { newOwnerMemberId, auth: authEnvelope() },
      currentUser.id,
      currentUser.name,
    )
    setSettings(resp.settings)
  }, [projectId, currentUser.id, currentUser.name])

  const remove = useCallback(async () => {
    await projectSettingsApi.delete(projectId, { auth: authEnvelope() }, currentUser.id, currentUser.name)
    setSettings(null)
  }, [projectId, currentUser.id, currentUser.name])

  return {
    settings,
    memberOptions,
    loading,
    error,
    reload: load,
    update,
    archive,
    restore,
    transfer,
    remove,
  }
}
