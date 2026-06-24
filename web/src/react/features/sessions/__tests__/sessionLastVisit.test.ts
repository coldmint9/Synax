import { afterEach, describe, expect, it } from 'vitest'
import {
  clearSessionLastVisit,
  loadSessionLastVisit,
  resolveGoalSessionsEntryPath,
  saveSessionLastVisit,
  sessionLastVisitPath,
} from '../sessionLastVisit'

const PROJECT_ID = 'p-test'

describe('sessionLastVisit', () => {
  afterEach(() => {
    clearSessionLastVisit(PROJECT_ID)
  })

  it('persists new draft visit', () => {
    saveSessionLastVisit(PROJECT_ID, { kind: 'new' })
    expect(loadSessionLastVisit(PROJECT_ID)).toEqual({ kind: 'new' })
    expect(sessionLastVisitPath(PROJECT_ID, { kind: 'new' })).toBe('/projects/p-test/sessions/new')
  })

  it('persists session visit', () => {
    saveSessionLastVisit(PROJECT_ID, { kind: 'session', sessionId: 'ars_1' })
    expect(loadSessionLastVisit(PROJECT_ID)).toEqual({ kind: 'session', sessionId: 'ars_1' })
    expect(resolveGoalSessionsEntryPath(PROJECT_ID)).toBe('/projects/p-test/sessions?session=ars_1')
  })

  it('falls back to bare list when no visit saved', () => {
    expect(resolveGoalSessionsEntryPath(PROJECT_ID)).toBe('/projects/p-test/sessions')
  })
})
