import { describe, expect, it } from 'vitest'
import {
  sessionPath,
  sessionsPath,
  isBareSessionsPath,
  isNewSessionPath,
  newSessionPath,
} from '../sessionRoutes'

describe('sessionRoutes', () => {
  it('builds session paths', () => {
    expect(sessionsPath('p1')).toBe('/projects/p1/sessions')
    expect(newSessionPath('p1')).toBe('/projects/p1/sessions/new')
    expect(sessionPath('p1', 'ars_1')).toBe('/projects/p1/sessions?session=ars_1')
  })

  it('detects new session draft path', () => {
    expect(isNewSessionPath('/projects/p1/sessions/new')).toBe(true)
    expect(isNewSessionPath('/projects/p1/sessions')).toBe(false)
  })

  it('detects bare sessions list', () => {
    expect(isBareSessionsPath('/projects/p1/sessions', 'p1')).toBe(true)
    expect(isBareSessionsPath('/projects/p1/sessions/new', 'p1')).toBe(false)
    expect(isBareSessionsPath('/projects/p1/sessions/workflows', 'p1')).toBe(false)
    expect(isBareSessionsPath('/projects/p1/sessions?session=x', 'p1')).toBe(false)
  })
})
