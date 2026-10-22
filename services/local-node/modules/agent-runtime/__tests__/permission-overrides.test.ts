import { describe, expect, it } from 'vitest'
import { applyPermissionOverrides } from '../permission-overrides.js'

describe('applyPermissionOverrides', () => {
  const defaults = [
    { gate: 'read' as const, pattern: '*', action: 'allow' as const },
    { gate: 'write' as const, pattern: '*', action: 'ask' as const },
    { gate: 'shell' as const, pattern: '*', action: 'ask' as const },
  ]

  it('returns defaults when overrides are empty', () => {
    expect(applyPermissionOverrides(defaults)).toEqual(defaults)
    expect(applyPermissionOverrides(defaults, {})).toEqual(defaults)
  })

  it('overrides matching gates only', () => {
    const merged = applyPermissionOverrides(defaults, { write: 'allow', shell: 'deny' })
    expect(merged.find(r => r.gate === 'read')?.action).toBe('allow')
    expect(merged.find(r => r.gate === 'write')?.action).toBe('allow')
    expect(merged.find(r => r.gate === 'shell')?.action).toBe('deny')
  })
  it('honors explicit restrictions even when the profile grants a wildcard', () => {
    const merged = applyPermissionOverrides([{ gate: '*', pattern: '*', action: 'allow' }], { write: 'deny', task: 'deny' })
    expect(merged).toEqual(expect.arrayContaining([
      expect.objectContaining({ gate: 'write', pattern: '*', action: 'deny' }),
      expect.objectContaining({ gate: 'task', pattern: '*', action: 'deny' }),
    ]))
  })
})
