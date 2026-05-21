import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyForest, type CoordForest } from '../../lib/coordinates'

function createSavedStateResponse(projectId: string, forest: CoordForest) {
  return {
    forest,
    revision: forest.revision,
    event: {
      id: 'evt-save',
      projectId,
      revision: forest.revision,
      type: 'coordinates_state_saved' as const,
      nodeId: null,
      runId: null,
      contextBlockIds: [],
      causedByEventIds: [],
      payload: {},
      actorId: 'web',
      createdAt: new Date(0).toISOString(),
    },
    updatedAt: new Date(0).toISOString(),
  }
}

class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  private writes = 0

  constructor(private readonly mode: 'ok' | 'always-fail' = 'ok') {}

  get length() {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.writes += 1
    if (this.mode === 'always-fail') throw new DOMException(`quota:${key}:${value.length}:${this.writes}`, 'QuotaExceededError')
    this.data.set(key, value)
  }
}

function installStorage(storage: Storage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}

function buildActionForest(projectId: string, runCount: number): CoordForest {
  const forest = createEmptyForest(projectId, 'Project')
  const actionId = `action-${projectId}`
  forest.nodes[actionId] = {
    id: actionId,
    type: 'action',
    label: 'Action',
    summary: 'Do the thing',
    status: runCount > 0 ? 'done' : 'pending',
    progress: runCount > 0 ? 100 : 0,
    parentId: forest.rootId,
    children: [],
    origin: 'manual',
    createdAt: 1,
    updatedAt: 2,
    runs: Array.from({ length: runCount }, (_, index) => ({
      runId: `run-${projectId}-${index}`,
      provider: 'opencode-acp',
      status: 'completed' as const,
      startedAt: index + 1,
      completedAt: index + 2,
      prompt: `prompt-${index}`,
      events: [{
        type: 'agent_message' as const,
        ts: index + 1,
        runId: `run-${projectId}-${index}`,
        clusterId: actionId,
        intent: 'ship',
        payload: { message: `event-${index}` },
      }],
      changeSummary: { added: 0, modified: 1, deleted: 0, files: 1, insertions: 1, deletions: 0 },
      fileChanges: [{ path: `src/file-${index}.ts`, changeType: 'modified' as const, additions: 1, deletions: 0, source: 'git' }],
    })),
  }
  forest.nodes[forest.rootId].children = [actionId]
  forest.edges = [{ id: `edge-${projectId}`, source: forest.rootId, target: actionId, type: 'hierarchy', strength: 1 }]
  return forest
}

describe('coordinatesStore local snapshot hydration', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    installStorage(new MemoryStorage())
  })

  it('merges backend forest with locally persisted runs and UI state', async () => {
    const coordinatesApi = await import('../../lib/api/coordinates.ts')
    const analyzerApi = await import('../../lib/api/analyzer.ts')
    const localForest = buildActionForest('merge-project', 1)
    const backendForest = buildActionForest('merge-project', 0)
    backendForest.revision = 2
    backendForest.codeIndex = {
      indexId: 'idx',
      files: [{ id: 'f1', path: 'src/index.ts', language: 'ts', size: 12, sha: 'sha' }],
      symbols: [],
      chunks: [],
      stats: { fileCount: 1, symbolCount: 0, chunkCount: 0 },
      updatedAt: 10,
    }

    const repo = coordinatesApi.createLocalStorageCoordinatesRepository()
    repo.saveGraph('merge-project', {
      version: 3,
      forest: localForest,
      nodePositions: { [localForest.rootId]: { x: 10, y: 20 }, 'action-merge-project': { x: 30, y: 40 } },
      layoutMode: 'freeform',
      backgroundMode: 'gridLight',
    })

    vi.spyOn(coordinatesApi, 'fetchCoordinatesState').mockResolvedValue({
      forest: backendForest,
      revision: backendForest.revision,
      eventHeadRevision: 0,
      context: {
        blocks: [],
        bindings: [],
        bundles: [],
        runSnapshots: [],
        loopRecords: [],
        signals: [],
        disclosureSuggestions: [],
        recentEvents: [],
        headRevision: 0,
      },
      updatedAt: null,
    })
    vi.spyOn(coordinatesApi, 'saveCoordinatesState').mockImplementation(async (projectId: string, forest: CoordForest) => (
      createSavedStateResponse(projectId, forest)
    ))
    vi.spyOn(coordinatesApi, 'recordRunVerdict').mockResolvedValue({ block: null })
    vi.spyOn(coordinatesApi, 'createNodeContextBinding').mockResolvedValue({
      binding: null,
      context: {
        blocks: [],
        bindings: [],
        bundles: [],
        runSnapshots: [],
        loopRecords: [],
        signals: [],
        disclosureSuggestions: [],
        recentEvents: [],
        headRevision: 0,
      },
    } as never)
    vi.spyOn(analyzerApi, 'fetchForestSnapshot').mockResolvedValue(null)

    const { useCoordinatesStore } = await import('./coordinatesStore.ts')
    const store = useCoordinatesStore('merge-project', 'Project')

    expect(store.getState().backgroundMode).toBe('gridLight')
    expect(store.getState().forest.nodes['action-merge-project'].runs).toHaveLength(1)

    const changed = await store.getState().hydrateFromBackend()

    expect(changed).toBe(true)
    expect(store.getState().forest.codeIndex.stats.fileCount).toBe(1)
    expect(store.getState().forest.nodes['action-merge-project'].runs).toHaveLength(1)
    expect(store.getState().nodePositions['action-merge-project']).toEqual({ x: 30, y: 40 })
    expect(store.getState().backgroundMode).toBe('gridLight')
  })

  it('preserves richer local run history when backend has fewer runs', async () => {
    const coordinatesApi = await import('../../lib/api/coordinates.ts')
    const localForest = buildActionForest('run-project', 2)
    const backendForest = buildActionForest('run-project', 1)
    backendForest.revision = 5

    const repo = coordinatesApi.createLocalStorageCoordinatesRepository()
    repo.saveGraph('run-project', {
      version: 3,
      forest: localForest,
      nodePositions: {},
      layoutMode: 'freeform',
      backgroundMode: 'plain',
    })

    vi.spyOn(coordinatesApi, 'fetchCoordinatesState').mockResolvedValue({
      forest: backendForest,
      revision: backendForest.revision,
      eventHeadRevision: 0,
      context: {
        blocks: [],
        bindings: [],
        bundles: [],
        runSnapshots: [],
        loopRecords: [],
        signals: [],
        disclosureSuggestions: [],
        recentEvents: [],
        headRevision: 0,
      },
      updatedAt: null,
    })
    vi.spyOn(coordinatesApi, 'saveCoordinatesState').mockImplementation(async (projectId: string, forest: CoordForest) => (
      createSavedStateResponse(projectId, forest)
    ))

    const { useCoordinatesStore } = await import('./coordinatesStore.ts')
    const store = useCoordinatesStore('run-project', 'Project')

    await store.getState().hydrateFromBackend()

    const runs = store.getState().forest.nodes['action-run-project'].runs ?? []
    expect(runs).toHaveLength(2)
    expect(runs[1].runId).toBe('run-run-project-1')
  })

  it('keeps analyzer completion on the ready path even when browser storage is full', async () => {
    installStorage(new MemoryStorage('always-fail'))
    const coordinatesApi = await import('../../lib/api/coordinates.ts')
    const analyzerApi = await import('../../lib/api/analyzer.ts')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const completedForest = buildActionForest('stream-project', 0)
    completedForest.revision = 9
    completedForest.analysis = { ...completedForest.analysis, phase: 'ready', progress: 100 }
    completedForest.lifecycle = { ...completedForest.lifecycle, initState: 'ready' }

    vi.spyOn(coordinatesApi, 'fetchCoordinatesState').mockResolvedValue({
      forest: null,
      revision: 0,
      eventHeadRevision: 0,
      context: {
        blocks: [],
        bindings: [],
        bundles: [],
        runSnapshots: [],
        loopRecords: [],
        signals: [],
        disclosureSuggestions: [],
        recentEvents: [],
        headRevision: 0,
      },
      updatedAt: null,
    })
    vi.spyOn(coordinatesApi, 'saveCoordinatesState').mockImplementation(async (projectId: string, forest: CoordForest) => (
      createSavedStateResponse(projectId, forest)
    ))
    vi.spyOn(analyzerApi, 'initializeFromRepoStream').mockImplementation((_input, onEvent) => {
      void Promise.resolve().then(() => {
        onEvent({ type: 'analysis_completed', payload: { forest: completedForest } })
      })
      return () => {}
    })

    const { useCoordinatesStore } = await import('./coordinatesStore.ts')
    const store = useCoordinatesStore('stream-project', 'Project')

    await store.getState().initializeFromRepo({ kind: 'localPath', localPath: '/tmp/project' })

    expect(store.getState().forest.analysis.phase).toBe('ready')
    expect(store.getState().forest.lifecycle.initState).toBe('ready')
    expect(consoleError).not.toHaveBeenCalledWith('[analyzer] stream error:', expect.anything())
    consoleError.mockRestore()
  })
})
