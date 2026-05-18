import {
  createEmptyCodeIndex,
  createEmptySemanticGraph,
  createEmptySourceBinding,
  createIdleAnalysis,
  createIdleLifecycle,
  type AgentRun,
  type CodeIndex,
  type CoordNode,
  type CoordEdge,
  type ContextBinding,
  type ContextBindingRelation,
  type ContextBlock,
  type CoordinatesContextIndex,
  type CoordEventLogEntry,
  type ContextDisclosureSuggestion,
  type AgentLoopRecord,
  type SynapseNodeContext,
  type ForestPatch,
  type SemanticGraph,
  type SourceBinding,
  type SourceLink,
  migrateForestV2ToV3,
  type CoordBackgroundMode,
  type CoordForest,
  type CoordLayoutMode,
  type CoordNodePositions,
} from '../coordinates'
import type { CoordinatesRunEvent } from '../agents/contracts'
import { apiFetch } from './origin'

export interface CoordinatesSnapshot {
  version: number
  forest: CoordForest
  nodePositions: CoordNodePositions
  layoutMode: CoordLayoutMode
  backgroundMode: CoordBackgroundMode
}

export interface CoordinatesRepository {
  loadGraph(projectId: string): CoordinatesSnapshot | null
  saveGraph(projectId: string, snapshot: CoordinatesSnapshot): void
}

export interface CoordinatesStateResponse {
  forest: CoordForest | null
  revision: number
  eventHeadRevision: number
  context: CoordinatesContextIndex
  updatedAt: string | null
}

export interface CoordinatesSaveStateResponse {
  forest: CoordForest
  revision: number
  event: CoordEventLogEntry
  updatedAt: string
}

export interface CodeMapScanRequest {
  projectId: string
  source?: SourceBinding
  workDir?: string
  include?: Array<'all' | 'module-map' | 'communities' | 'coord-seed'>
  limits?: {
    maxCommunities?: number
    maxEntryFiles?: number
    maxCoreSymbols?: number
    maxDependencies?: number
    maxActionsPerCommunity?: number
    evidencePerFeature?: number
  }
  actorId?: string | null
}

export interface CodeMapScanResult {
  projectId: string
  scanId: string
  generatedAt: number
  durationMs: number
  workDir: string
  source?: SourceBinding | null
  codeIndex: CodeIndex & {
    imports: Array<{
      sourceFileId: string
      targetModule: string
      line: number
      level: number
      isExternal: boolean
    }>
    stats: CodeIndex['stats'] & { importCount: number }
  }
  semanticGraph: SemanticGraph
  moduleMap?: unknown
  communities?: unknown
  coordSeed?: {
    rootId: string
    nodes: CoordNode[]
    edges: CoordEdge[]
    links: SourceLink[]
    patch: ForestPatch
  } | null
  warnings: string[]
}

const STORAGE_KEY = 'synapse.coordinates.snapshot'
/** v3 CoordForest schema 隨动升版，旧数据会被 migrateForestV2ToV3 接管。 */
const SNAPSHOT_VERSION = 3
const LOCAL_STORAGE_BUCKET_VERSION = 1
const LOCAL_SNAPSHOT_VERSION = 1

type CompactionLevel = 'default' | 'aggressive' | 'minimal'

interface PersistedLocalForestSnapshot {
  projectId: string
  schemaVersion: CoordForest['schemaVersion']
  revision: number
  rootId: string
  nodes: CoordForest['nodes']
  edges: CoordForest['edges']
  source: CoordForest['source']
  analysis: CoordForest['analysis']
  lifecycle: CoordForest['lifecycle']
  convergence?: CoordForest['convergence']
  meta: CoordForest['meta']
}

interface PersistedLocalCoordinatesSnapshot {
  storageVersion: typeof LOCAL_SNAPSHOT_VERSION
  version: number
  forest: PersistedLocalForestSnapshot
  nodePositions: CoordNodePositions
  layoutMode: CoordLayoutMode
  backgroundMode: CoordBackgroundMode
}

interface PersistedLocalBucket {
  bucketVersion: typeof LOCAL_STORAGE_BUCKET_VERSION
  projects: Record<string, PersistedLocalCoordinatesSnapshot>
}

const COMPACTION_LIMITS: Record<CompactionLevel, {
  runsPerNode: number
  eventsPerRun: number
  fileChangesPerRun: number
  maxStringLength: number
  maxArrayItems: number
}> = {
  default: { runsPerNode: 8, eventsPerRun: 12, fileChangesPerRun: 32, maxStringLength: 1200, maxArrayItems: 24 },
  aggressive: { runsPerNode: 4, eventsPerRun: 6, fileChangesPerRun: 12, maxStringLength: 400, maxArrayItems: 12 },
  minimal: { runsPerNode: 1, eventsPerRun: 0, fileChangesPerRun: 8, maxStringLength: 200, maxArrayItems: 8 },
}

export function createLocalStorageCoordinatesRepository(): CoordinatesRepository {
  return {
    loadGraph(projectId: string) {
      const projects = readStoredProjects()
      return restoreSnapshot(projects[projectId] ?? null)
    },
    saveGraph(projectId: string, snapshot: CoordinatesSnapshot) {
      const projects = readStoredProjects()
      const nextProjects = normalizeStoredProjects(projects)
      for (const level of ['default', 'aggressive', 'minimal'] as const) {
        nextProjects[projectId] = compactSnapshot(snapshot, level)
        try {
          writeStoredProjects(nextProjects)
          return
        } catch (err) {
          if (!isQuotaExceededError(err)) throw err
          if (level === 'minimal') {
            console.warn('[coordinates] local snapshot skipped after repeated quota overflow')
          }
        }
      }
    },
  }
}

function readStoredProjects(): Record<string, unknown> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as PersistedLocalBucket | Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    if ('bucketVersion' in parsed && parsed.bucketVersion === LOCAL_STORAGE_BUCKET_VERSION && 'projects' in parsed) {
      const projects = (parsed as PersistedLocalBucket).projects
      return projects && typeof projects === 'object' ? projects : {}
    }
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeStoredProjects(projects: Record<string, PersistedLocalCoordinatesSnapshot>) {
  const bucket: PersistedLocalBucket = {
    bucketVersion: LOCAL_STORAGE_BUCKET_VERSION,
    projects,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bucket))
}

function normalizeStoredProjects(projects: Record<string, unknown>): Record<string, PersistedLocalCoordinatesSnapshot> {
  const normalized: Record<string, PersistedLocalCoordinatesSnapshot> = {}
  for (const [projectId, value] of Object.entries(projects)) {
    if (isPersistedLocalSnapshot(value)) {
      normalized[projectId] = value
      continue
    }
    const restored = restoreSnapshot(value)
    if (restored) normalized[projectId] = compactSnapshot(restored, 'default')
  }
  return normalized
}

function restoreSnapshot(input: unknown): CoordinatesSnapshot | null {
  if (!input || typeof input !== 'object') return null
  if (isPersistedLocalSnapshot(input)) return restorePersistedLocalSnapshot(input)
  return restoreLegacySnapshot(input as CoordinatesSnapshot)
}

function restoreLegacySnapshot(snapshot: CoordinatesSnapshot): CoordinatesSnapshot | null {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.forest) return null
  try {
    return {
      ...snapshot,
      version: SNAPSHOT_VERSION,
      forest: migrateForestV2ToV3(snapshot.forest),
    }
  } catch {
    return null
  }
}

function restorePersistedLocalSnapshot(snapshot: PersistedLocalCoordinatesSnapshot): CoordinatesSnapshot | null {
  try {
    return {
      version: SNAPSHOT_VERSION,
      nodePositions: snapshot.nodePositions ?? {},
      layoutMode: snapshot.layoutMode ?? 'freeform',
      backgroundMode: snapshot.backgroundMode ?? 'plain',
      forest: migrateForestV2ToV3({
        ...snapshot.forest,
        source: snapshot.forest.source ?? createEmptySourceBinding(),
        codeIndex: createEmptyCodeIndex(),
        semanticGraph: createEmptySemanticGraph(),
        links: [],
        analysis: snapshot.forest.analysis ?? createIdleAnalysis(),
        lifecycle: snapshot.forest.lifecycle ?? createIdleLifecycle(),
      }),
    }
  } catch {
    return null
  }
}

function compactSnapshot(
  snapshot: CoordinatesSnapshot,
  level: CompactionLevel,
): PersistedLocalCoordinatesSnapshot {
  return {
    storageVersion: LOCAL_SNAPSHOT_VERSION,
    version: SNAPSHOT_VERSION,
    nodePositions: snapshot.nodePositions,
    layoutMode: snapshot.layoutMode,
    backgroundMode: snapshot.backgroundMode,
    forest: compactForest(snapshot.forest, level),
  }
}

function compactForest(forest: CoordForest, level: CompactionLevel): PersistedLocalForestSnapshot {
  const nodes = Object.fromEntries(
    Object.entries(forest.nodes).map(([nodeId, node]) => [nodeId, compactNode(node, level)]),
  )
  return {
    projectId: forest.projectId,
    schemaVersion: forest.schemaVersion,
    revision: forest.revision,
    rootId: forest.rootId,
    nodes,
    edges: forest.edges,
    source: forest.source,
    analysis: forest.analysis,
    lifecycle: forest.lifecycle,
    convergence: forest.convergence,
    meta: forest.meta,
  }
}

function compactNode(node: CoordNode, level: CompactionLevel): CoordNode {
  const limits = COMPACTION_LIMITS[level]
  return {
    ...node,
    summary: compactString(node.summary, limits.maxStringLength),
    artifactSummary: compactOptionalString(node.artifactSummary, limits.maxStringLength),
    correctionNote: compactOptionalString(node.correctionNote, limits.maxStringLength),
    agentRunLog: undefined,
    linkIds: undefined,
    runs: compactRuns(node.runs, level),
  }
}

function compactRuns(runs: AgentRun[] | undefined, level: CompactionLevel): AgentRun[] | undefined {
  if (!runs?.length) return runs
  const limits = COMPACTION_LIMITS[level]
  return runs.slice(-limits.runsPerNode).map(run => compactRun(run, level))
}

function compactRun(run: AgentRun, level: CompactionLevel): AgentRun {
  const limits = COMPACTION_LIMITS[level]
  const fileChanges = run.fileChanges?.slice(0, limits.fileChangesPerRun).map(change => ({
    ...change,
    path: compactString(change.path, limits.maxStringLength),
  }))
  return {
    runId: run.runId,
    provider: run.provider,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    artifactSummary: compactOptionalString(run.artifactSummary, limits.maxStringLength),
    events: limits.eventsPerRun === 0
      ? []
      : (run.events ?? []).slice(-limits.eventsPerRun).map(event => ({
          ...event,
          payload: compactJsonValue(
            event.payload,
            limits.maxStringLength,
            limits.maxArrayItems,
            0,
          ) as CoordinatesRunEvent['payload'],
        })),
    verdict: run.verdict,
    correctionNote: compactOptionalString(run.correctionNote, limits.maxStringLength),
    correctionReasons: run.correctionReasons,
    prompt: compactOptionalString(run.prompt, limits.maxStringLength),
    reviewId: run.reviewId,
    reviewVerdict: run.reviewVerdict,
    fileChanges,
    changeSummary: run.changeSummary,
    contextSnapshotId: run.contextSnapshotId,
    inputBlockIds: compactStringArray(run.inputBlockIds, limits.maxArrayItems),
    outputBlockIds: compactStringArray(run.outputBlockIds, limits.maxArrayItems),
    eventIds: compactStringArray(run.eventIds, limits.maxArrayItems),
    correctionContextBlockId: run.correctionContextBlockId,
  }
}

function compactJsonValue(
  value: unknown,
  maxStringLength: number,
  maxArrayItems: number,
  depth: number,
): unknown {
  if (typeof value === 'string') return compactString(value, maxStringLength)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    if (depth >= 2) return value.slice(0, maxArrayItems)
    return value.slice(0, maxArrayItems).map(item => compactJsonValue(item, maxStringLength, maxArrayItems, depth + 1))
  }
  if (typeof value === 'object') {
    if (depth >= 2) return undefined
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'forest' || key === 'patch') continue
      const compacted = compactJsonValue(entry, maxStringLength, maxArrayItems, depth + 1)
      if (compacted !== undefined) out[key] = compacted
    }
    return out
  }
  return undefined
}

function compactStringArray(values: string[] | undefined, maxItems: number): string[] | undefined {
  if (!values?.length) return values
  return values.slice(0, maxItems)
}

function compactOptionalString(value: string | undefined, maxLength: number): string | undefined {
  return typeof value === 'string' ? compactString(value, maxLength) : value
}

function compactString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 1)}…`
}

function isPersistedLocalSnapshot(value: unknown): value is PersistedLocalCoordinatesSnapshot {
  return Boolean(
    value
      && typeof value === 'object'
      && 'storageVersion' in value
      && (value as { storageVersion?: unknown }).storageVersion === LOCAL_SNAPSHOT_VERSION
      && 'forest' in value,
  )
}

function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = 'name' in err ? String((err as { name?: unknown }).name) : ''
  const code = 'code' in err ? Number((err as { code?: unknown }).code) : NaN
  return name === 'QuotaExceededError' || code === 22 || code === 1014
}

export function createHttpCoordinatesRepository(): CoordinatesRepository {
  return {
    loadGraph() {
      return null
    },
    saveGraph() {
      // Stub for future backend persistence.
    },
  }
}

const COORD_API_BASE = '/api/coordinates'

async function parseJson<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`)
  }
  return (await resp.json()) as T
}

export async function fetchCoordinatesState(projectId: string): Promise<CoordinatesStateResponse> {
  return apiFetch(`${COORD_API_BASE}/${encodeURIComponent(projectId)}/state`).then(parseJson<CoordinatesStateResponse>)
}

export async function saveCoordinatesState(
  projectId: string,
  forest: CoordForest,
  actorId = 'web',
): Promise<CoordinatesSaveStateResponse> {
  return apiFetch(`${COORD_API_BASE}/${encodeURIComponent(projectId)}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forest, actorId }),
  }).then(parseJson<CoordinatesSaveStateResponse>)
}

export async function scanCodeMap(input: CodeMapScanRequest): Promise<CodeMapScanResult> {
  return apiFetch(`${COORD_API_BASE}/code-map/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(parseJson<CodeMapScanResult>)
}

export async function fetchCoordEvents(
  projectId: string,
  afterRevision = 0,
): Promise<{ items: CoordEventLogEntry[]; headRevision: number }> {
  const qs = new URLSearchParams({ projectId, afterRevision: String(afterRevision) })
  return apiFetch(`${COORD_API_BASE}/events?${qs.toString()}`).then(parseJson<{ items: CoordEventLogEntry[]; headRevision: number }>)
}

export async function fetchRunLoop(projectId: string, runId: string): Promise<AgentLoopRecord> {
  const qs = new URLSearchParams({ projectId })
  return apiFetch(`${COORD_API_BASE}/runs/${encodeURIComponent(runId)}/loop?${qs.toString()}`).then(parseJson<AgentLoopRecord>)
}

export async function fetchNodeLoops(
  projectId: string,
  nodeId: string,
  limit = 20,
): Promise<{ items: AgentLoopRecord[] }> {
  const qs = new URLSearchParams({ projectId, limit: String(limit) })
  return apiFetch(`${COORD_API_BASE}/nodes/${encodeURIComponent(nodeId)}/loops?${qs.toString()}`).then(parseJson<{ items: AgentLoopRecord[] }>)
}

export async function fetchSynapseNodeContext(
  projectId: string,
  nodeId: string,
): Promise<SynapseNodeContext> {
  const qs = new URLSearchParams({ projectId })
  return apiFetch(`${COORD_API_BASE}/nodes/${encodeURIComponent(nodeId)}/synapse-context?${qs.toString()}`).then(parseJson<SynapseNodeContext>)
}

export async function acceptContextSuggestion(input: {
  projectId: string
  suggestionId: string
  actorId?: string | null
}): Promise<ContextDisclosureSuggestion> {
  return apiFetch(`${COORD_API_BASE}/context-suggestions/${encodeURIComponent(input.suggestionId)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: input.projectId, actorId: input.actorId ?? 'web' }),
  }).then(parseJson<ContextDisclosureSuggestion>)
}

export async function dismissContextSuggestion(input: {
  projectId: string
  suggestionId: string
  actorId?: string | null
}): Promise<ContextDisclosureSuggestion> {
  return apiFetch(`${COORD_API_BASE}/context-suggestions/${encodeURIComponent(input.suggestionId)}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: input.projectId, actorId: input.actorId ?? 'web' }),
  }).then(parseJson<ContextDisclosureSuggestion>)
}

export async function shareContextSignal(input: {
  projectId: string
  signalId: string
  targetNodeId?: string | null
  actorId?: string | null
}): Promise<{ items: ContextDisclosureSuggestion[] }> {
  return apiFetch(`${COORD_API_BASE}/context-signals/${encodeURIComponent(input.signalId)}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: input.projectId,
      targetNodeId: input.targetNodeId ?? null,
      actorId: input.actorId ?? 'web',
    }),
  }).then(parseJson<{ items: ContextDisclosureSuggestion[] }>)
}

export async function createNodeContextBinding(input: {
  projectId: string
  nodeId: string
  blockId: string
  relation?: ContextBindingRelation
  confidence?: number
  metadata?: Record<string, unknown>
  createdBy?: string | null
}): Promise<ContextBinding> {
  return apiFetch(`${COORD_API_BASE}/nodes/${encodeURIComponent(input.nodeId)}/context-bindings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: input.projectId,
      blockId: input.blockId,
      relation: input.relation ?? 'references',
      confidence: input.confidence,
      metadata: input.metadata,
      createdBy: input.createdBy ?? 'web',
    }),
  }).then(parseJson<ContextBinding>)
}

export async function recordRunVerdict(input: {
  projectId: string
  nodeId: string
  runId: string
  verdict: 'accepted' | 'rejected'
  note?: string
  reasons?: string[]
  actorId?: string | null
}): Promise<{ block: unknown }> {
  return apiFetch(`${COORD_API_BASE}/runs/${encodeURIComponent(input.runId)}/verdict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: input.projectId,
      nodeId: input.nodeId,
      verdict: input.verdict,
      note: input.note,
      reasons: input.reasons,
      actorId: input.actorId ?? 'web',
    }),
  }).then(parseJson<{ block: unknown }>)
}
