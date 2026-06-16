import { beforeEach, describe, expect, it } from 'vitest'
import { profileService } from '../profile-service.js'
import { ensurePlanProfileRegistered, PLAN_PLANNER_PROFILE_ID } from '../../wiki/wiki-plan-profile.js'

describe('plan planner profile', () => {
  beforeEach(() => {
    ensurePlanProfileRegistered()
  })

  it('registers read-only planner without shell or write', () => {
    const profile = profileService.get(PLAN_PLANNER_PROFILE_ID)
    expect(profile.kind).toBe('planner')
    expect(profile.allowedCapabilities).not.toContain('file.write')
    expect(profile.allowedCapabilities).not.toContain('bash')
    expect(profile.permissionDefaults.find(r => r.gate === 'write')?.action).toBe('deny')
    expect(profile.permissionDefaults.find(r => r.gate === 'shell')?.action).toBe('deny')
  })
})
