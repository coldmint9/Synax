import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyForest } from '../coordinates'
import { createLocalStorageCoordinatesRepository } from './coordinates'

class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  private writes = 0

  constructor(private readonly mode: 'ok' | 'fail-once' | 'always-fail' = 'ok') {}

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
    if (this.mode === 'always-fail') throw new DOMException('quota', 'QuotaExceededError')
    if (this.mode === 'fail-once' && this.writes === 1) throw new DOMException('quota', 'QuotaExceededError')
    this.data.set(key, value)
  }

  dump(key: string) {
    return this.data.get(key) ?? null
  }
}

function installStorage(storage: Storage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}

function buildSnapshot(projectId: string, eventCount = 3) {
  const forest = createEmptyForest(projectId, 'Project')
  const root = forest.nodes[forest.rootId]
  const actionId = `action-${projectId}`
  forest.nodes[actionId] = {
    id: actionId,
    type: 'action',
    label: 'Ship fix',
    summary: 'Investigate and patch persistence overflow.',
    status: 'done',
    progress: 100,
    parentId: forest.rootId,
    children: [],
    origin: 'manual',
    createdAt: 1,
    updatedAt: 2,
    runs: [{
      runId: `run-${projectId}`,
      provider: 'opencode-acp',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      prompt: 'Please patch the storage logic',
      events: Array.from({ length: eventCount }, (_, index) => ({
        type: 'agent_message' as const,
        ts: index + 1,
        runId: `run-${projectId}`,
        clusterId: actionId,
        intent: 'Patch storage',
        payload: { message: `event-${index}` },
      })),
      fileChanges: Array.from({ length: 4 }, (_, index) => ({
        path: `web/src/file-${index}.ts`,
        changeType: 'modified' as const,
        additions: index + 1,
        deletions: index,
        source: 'git',
      })),
      changeSummary: { added: 0, modified: 4, deleted: 0, files: 4, insertions: 10, deletions: 2 },
    }],
  }
  root.children = [actionId]
  forest.edges = [{ id: `edge-${projectId}`, source: forest.rootId, target: actionId, type: 'hierarchy', strength: 1 }]
  forest.codeIndex = {
    indexId: 'idx',
    files: [{ id: 'f1', path: 'src/index.ts', language: 'ts', size: 99, sha: 'abc' }],
    symbols: [],
    chunks: [],
    stats: { fileCount: 1, symbolCount: 0, chunkCount: 0 },
    updatedAt: 123,
  }
  forest.semanticGraph = { nodes: [{ id: 's1', kind: 'module', label: 'mod', evidence: { fileIds: ['f1'], symbolIds: [] }, score: 1 }], edges: [] }
  forest.links = [{ id: 'l1', nodeId: actionId, anchor: { kind: 'file', fileId: 'f1' }, confidence: 0.9, createdBy: 'analyzer' }]
  return {
    version: 3,
    forest,
    nodePositions: { [forest.rootId]: { x: 1, y: 2 }, [actionId]: { x: 3, y: 4 } },
    layoutMode: 'freeform' as const,
    backgroundMode: 'gridLight' as const,
  }
}

describe('createLocalStorageCoordinatesRepository', () => {
  beforeEach(() => {
    installStorage(new MemoryStorage())
  })

  it('loads legacy snapshots and rewrites compact storage on save', () => {
    const storage = new MemoryStorage()
    installStorage(storage)
    const snapshot = buildSnapshot('legacy')
    storage.setItem('synapse.coordinates.snapshot', JSON.stringify({ legacy: snapshot }))

    const repo = createLocalStorageCoordinatesRepository()
    const loaded = repo.loadGraph('legacy')

    expect(loaded?.forest.codeIndex.files).toHaveLength(1)
    repo.saveGraph('legacy', loaded!)

    const raw = JSON.parse(storage.dump('synapse.coordinates.snapshot') ?? '{}') as {
      bucketVersion: number
      projects: Record<string, { forest: Record<string, unknown> }>
    }
    expect(raw.bucketVersion).toBe(1)
    expect(raw.projects.legacy.forest).not.toHaveProperty('codeIndex')
    expect(raw.projects.legacy.forest).not.toHaveProperty('semanticGraph')
    expect(raw.projects.legacy.forest).not.toHaveProperty('links')
  })

  it('saves compact snapshots by default', () => {
    const storage = new MemoryStorage()
    installStorage(storage)
    const repo = createLocalStorageCoordinatesRepository()

    repo.saveGraph('compact', buildSnapshot('compact'))

    const raw = JSON.parse(storage.dump('synapse.coordinates.snapshot') ?? '{}') as {
      projects: Record<string, { forest: Record<string, unknown> }>
    }
    expect(raw.projects.compact.forest).not.toHaveProperty('codeIndex')
    expect(raw.projects.compact.forest).not.toHaveProperty('semanticGraph')
    expect(raw.projects.compact.forest).not.toHaveProperty('links')
    expect(raw.projects.compact.forest.nodes['action-compact'].runs[0].events).toHaveLength(3)
  })

  it('retries with a smaller snapshot after quota overflow', () => {
    const storage = new MemoryStorage('fail-once')
    installStorage(storage)
    const repo = createLocalStorageCoordinatesRepository()

    repo.saveGraph('retry', buildSnapshot('retry', 7))

    const raw = JSON.parse(storage.dump('synapse.coordinates.snapshot') ?? '{}') as {
      projects: Record<string, { forest: { nodes: Record<string, { runs?: Array<{ events: unknown[] }> }> } }>
    }
    expect(raw.projects.retry.forest.nodes['action-retry'].runs?.[0].events).toHaveLength(6)
  })

  it('swallows repeated quota overflow without throwing', () => {
    const storage = new MemoryStorage('always-fail')
    installStorage(storage)
    const repo = createLocalStorageCoordinatesRepository()

    expect(() => repo.saveGraph('drop', buildSnapshot('drop', 9))).not.toThrow()
    expect(storage.dump('synapse.coordinates.snapshot')).toBeNull()
  })
})
