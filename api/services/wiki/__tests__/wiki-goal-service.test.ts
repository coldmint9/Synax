import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockLimit = vi.fn()
const mockOrderBy = vi.fn(() => ({ limit: mockLimit }))
const mockWhere = vi.fn(() => ({ limit: mockLimit, orderBy: mockOrderBy }))
const mockFrom = vi.fn(() => ({ where: mockWhere, orderBy: mockOrderBy }))
const mockSelect = vi.fn(() => ({ from: mockFrom }))
const mockValues = vi.fn().mockResolvedValue(undefined)
const mockInsert = vi.fn(() => ({ values: mockValues }))
const mockSetWhere = vi.fn().mockResolvedValue(undefined)
const mockSet = vi.fn(() => ({ where: mockSetWhere }))
const mockUpdate = vi.fn(() => ({ set: mockSet }))
const mockDeleteWhere = vi.fn().mockResolvedValue(undefined)
const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }))

const mockDb = { select: mockSelect, insert: mockInsert, update: mockUpdate, delete: mockDelete }

vi.mock('../../../db/index.js', () => ({ getDb: () => mockDb }))
vi.mock('../../../db/schema.js', () => ({
  wikiGoals: { projectId: 'project_id', documentId: 'document_id', status: 'status' },
  wikiPlans: { projectId: 'project_id', id: 'id' },
  wikiPlanNodes: { planId: 'plan_id', sortOrder: 'sort_order' },
  wikiPlanNodeArtifacts: { nodeId: 'node_id' },
}))
vi.mock('nanoid', () => ({ nanoid: () => 'goal-test-id' }))

import { createGoal, listGoals, getNextExecutableNode } from '../wiki-goal-service.js'

describe('wiki-goal-service', () => {
  beforeEach(() => vi.clearAllMocks())

  it('createGoal inserts document-scoped goal with anchor', async () => {
    const goal = await createGoal({
      projectId: 'proj-1',
      content: 'Fix auth flow',
      scope: 'document',
      documentId: 'doc-1',
      anchorJson: { type: 'selection', quote: 'auth flow', heading: 'Authentication' },
    })
    expect(goal.id).toBe('goal-test-id')
    expect(goal.scope).toBe('document')
    expect(goal.documentId).toBe('doc-1')
    expect(goal.anchorJson?.heading).toBe('Authentication')
    expect(mockInsert).toHaveBeenCalled()
  })

  it('listGoals maps rows from db', async () => {
    mockOrderBy.mockResolvedValueOnce([{
      id: 'g1',
      projectId: 'proj-1',
      scope: 'project',
      documentId: null,
      content: 'Improve perf',
      anchorJson: null,
      status: 'active',
      planNodeId: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      resolvedAt: null,
    }])
    const goals = await listGoals('proj-1')
    expect(goals).toHaveLength(1)
    expect(goals[0].content).toBe('Improve perf')
  })

  it('getNextExecutableNode respects dependsOn titles', async () => {
    mockOrderBy.mockResolvedValueOnce([
      {
        id: 'n1', planId: 'p1', projectId: 'proj-1', title: 'Setup', description: '',
        goalIdsJson: '[]', evaluationIdsJson: '[]', dependsOnJson: '[]', expectedFilesJson: '[]',
        status: 'committed', sortOrder: 0, reviewResult: null,
        createdAt: 't', updatedAt: 't', completedAt: 't',
      },
      {
        id: 'n2', planId: 'p1', projectId: 'proj-1', title: 'Implement', description: '',
        goalIdsJson: '[]', evaluationIdsJson: '[]', dependsOnJson: '["Setup"]', expectedFilesJson: '[]',
        status: 'pending', sortOrder: 1, reviewResult: null,
        createdAt: 't', updatedAt: 't', completedAt: null,
      },
    ])
    const next = await getNextExecutableNode('p1')
    expect(next?.title).toBe('Implement')
  })

  it('getNextExecutableNode returns null when deps unmet', async () => {
    mockOrderBy.mockResolvedValueOnce([
      {
        id: 'n2', planId: 'p1', projectId: 'proj-1', title: 'Implement', description: '',
        goalIdsJson: '[]', evaluationIdsJson: '[]', dependsOnJson: '["Setup"]', expectedFilesJson: '[]',
        status: 'pending', sortOrder: 1, reviewResult: null,
        createdAt: 't', updatedAt: 't', completedAt: null,
      },
    ])
    const next = await getNextExecutableNode('p1')
    expect(next).toBeNull()
  })
})
