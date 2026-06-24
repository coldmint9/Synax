import { describe, expect, it } from 'vitest'
import {
  goalSessionPath,
  goalSessionsPath,
  isBareGoalSessionsPath,
  isNewGoalSessionPath,
  newGoalSessionPath,
  workflowSessionsPath,
} from '../sessionRoutes'

describe('sessionRoutes', () => {
  it('builds goal session paths', () => {
    expect(goalSessionsPath('p1')).toBe('/projects/p1/sessions')
    expect(newGoalSessionPath('p1')).toBe('/projects/p1/sessions/new')
    expect(goalSessionPath('p1', 'ars_1')).toBe('/projects/p1/sessions?session=ars_1')
    expect(workflowSessionsPath('p1')).toBe('/projects/p1/sessions/workflows')
  })

  it('detects new draft route', () => {
    expect(isNewGoalSessionPath('/projects/p1/sessions/new')).toBe(true)
    expect(isNewGoalSessionPath('/projects/p1/sessions')).toBe(false)
  })

  it('detects bare goal sessions list', () => {
    expect(isBareGoalSessionsPath('/projects/p1/sessions', 'p1')).toBe(true)
    expect(isBareGoalSessionsPath('/projects/p1/sessions/new', 'p1')).toBe(false)
    expect(isBareGoalSessionsPath('/projects/p1/sessions/workflows', 'p1')).toBe(false)
    expect(isBareGoalSessionsPath('/projects/p1/sessions?session=x', 'p1')).toBe(false)
  })
})
