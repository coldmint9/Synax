import fs from 'node:fs'
import path from 'node:path'

const SMOKE_ROOT = path.resolve(process.cwd(), '.data/_smoke_coordinates_context')
if (fs.existsSync(SMOKE_ROOT)) fs.rmSync(SMOKE_ROOT, { recursive: true, force: true })
fs.mkdirSync(SMOKE_ROOT, { recursive: true })
process.env.DATA_ROOT = SMOKE_ROOT
process.env.LOG_LEVEL = 'warn'

const { contextService } = await import('../services/context/context-service.js')
const { SynapseContextAgentService } = await import('../services/context/synapse-context-agent-service.js')

const projectId = 'proj_coord_ctx'
const userId = 'user-smoke'

function expect(name: string, cond: unknown, detail?: string) {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
    process.exitCode = 1
    throw new Error(name)
  }
  console.log(`OK   ${name}`)
}

const session = contextService.createSession(projectId, userId, { sourceAgent: 'smoke' })
const entry = contextService.appendEntry(session.id, {
  role: 'user',
  content: 'Implement login flow and keep OAuth callback secure.',
})
const memory = contextService.createMemory(projectId, {
  memoryType: 'decision',
  title: 'Auth provider',
  content: 'Use OAuth PKCE for browser login.',
  tags: ['auth', 'oauth'],
  references: { nodeIds: ['action_login_1'] },
})
contextService.createLink({
  projectId,
  entryId: entry.id,
  nodeId: 'action_login_1',
  linkType: 'discusses',
})

contextService.materializeLegacyContext(projectId)
const index1 = contextService.getCoordinatesContextIndex(projectId)
expect('legacy entry mapped to context block', index1.blocks.some((b) => b.sourceType === 'context_entry' && b.sourceId === entry.id))
expect('legacy memory mapped to context block', index1.blocks.some((b) => b.sourceType === 'project_memory' && b.sourceId === memory.id))

const forest = {
  projectId,
  schemaVersion: 3 as const,
  revision: 0,
  rootId: 'project-root',
  nodes: {
    'project-root': {
      id: 'project-root',
      type: 'project' as const,
      label: 'Smoke Project',
      summary: '',
      status: 'active' as const,
      progress: 0,
      parentId: null,
      children: ['action_login_1', 'action_profile_1'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    action_login_1: {
      id: 'action_login_1',
      type: 'action' as const,
      label: 'Implement login flow',
      summary: 'Create OAuth login flow',
      status: 'pending' as const,
      progress: 0,
      parentId: 'project-root',
      children: [],
      runs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      context: {},
    },
    action_profile_1: {
      id: 'action_profile_1',
      type: 'action' as const,
      label: 'Render profile after login',
      summary: 'Use authenticated profile data after OAuth login',
      status: 'pending' as const,
      progress: 0,
      parentId: 'project-root',
      children: [],
      runs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      context: {},
    },
  },
  edges: [
    {
      id: 'edge_login_profile_dep',
      source: 'action_login_1',
      target: 'action_profile_1',
      strength: 0.9,
      type: 'dependency' as const,
    },
  ],
  source: { kind: 'scratch' as const },
  codeIndex: { indexId: 'none', files: [], symbols: [], chunks: [], stats: { fileCount: 0, symbolCount: 0, chunkCount: 0 }, updatedAt: Date.now() },
  semanticGraph: { nodes: [], edges: [] },
  links: [],
  analysis: { phase: 'idle' as const, progress: 0 },
  lifecycle: { initState: 'idle' as const, autoSync: false },
  meta: { label: 'Smoke Project', createdAt: Date.now(), updatedAt: Date.now(), tokens: {} },
}

const saved = contextService.saveCoordinatesState(projectId, forest, userId)
expect('coordinates state saved with revision', saved.revision > 0)

const decisionBlock = index1.blocks.find((b) => b.sourceType === 'project_memory' && b.sourceId === memory.id)
if (!decisionBlock) throw new Error('decisionBlock not found')
const binding = contextService.createContextBinding({
  projectId,
  blockId: decisionBlock.id,
  targetKind: 'node',
  targetId: 'action_login_1',
  relation: 'uses',
  createdBy: userId,
})
expect('node context binding created', !!binding.id)

const snapshot = contextService.createRunSnapshot({
  projectId,
  nodeId: 'action_login_1',
  runId: 'run_smoke_1',
  prompt: 'Implement OAuth login',
  createdBy: userId,
})
expect('run snapshot created', snapshot.inputBlockIds.length > 0)

const runEvent = contextService.recordRunEvent({
  projectId,
  nodeId: 'action_login_1',
  runId: 'run_smoke_1',
  eventType: 'artifact_proposed',
  message: 'Prepared OAuth callback validation patch.',
  actorId: 'agent',
})
expect('run event log created', runEvent.event.type === 'run_event_recorded')
expect('artifact event created output block', runEvent.blocks.length === 1)

const chunkEvent = contextService.recordRunEvent({
  projectId,
  nodeId: 'action_login_1',
  runId: 'run_smoke_1',
  eventType: 'agent_message',
  message: 'token chunk that must not become durable context',
  actorId: 'agent',
})
expect('agent message chunk does not create context block', chunkEvent.blocks.length === 0)

const loop = contextService.recordAgentLoop({
  projectId,
  nodeId: 'action_login_1',
  runId: 'run_smoke_loop_1',
  provider: 'cursor-acp',
  status: 'completed',
  userId,
  rawInput: 'Implement OAuth login',
  contextSnapshotId: snapshot.id,
  summary: 'Implemented OAuth login loop.',
  finalOutput: 'Decision: use OAuth PKCE. Risk: callback state validation must remain strict. Updated api/auth.ts.',
  steps: [
    { kind: 'user_input', title: 'User request', content: 'Implement OAuth login' },
    { kind: 'agent_thought', title: 'Visible thought', content: 'Inspect auth flow.', metadata: { visible: true } },
    { kind: 'tool_call', title: 'Tool call', content: 'edit auth files' },
    { kind: 'tool_result', title: 'Tool result', content: 'api/auth.ts updated and tests passed' },
    { kind: 'final_output', title: 'Final output', content: 'Decision: use OAuth PKCE. Risk: callback state validation must remain strict. Updated api/auth.ts.' },
  ],
})
expect('agent loop record persisted', loop.steps?.length === 5)
expect('agent loop fetch by run id', contextService.getAgentLoopByRunId(projectId, 'run_smoke_loop_1')?.id === loop.id)
expect('agent loop listed by node', contextService.listAgentLoopsByNode(projectId, 'action_login_1').some((item) => item.id === loop.id))
const signalIndex = contextService.getCoordinatesContextIndex(projectId)
expect('recordAgentLoop does not create signals by itself', signalIndex.signals.filter((signal) => signal.sourceId === loop.id).length === 0)
const agentService = new SynapseContextAgentService(contextService, async () => ({
  signals: [
    {
      kind: 'decision',
      title: 'Use OAuth PKCE',
      summary: 'Use OAuth PKCE for browser login.',
      content: 'Decision: use OAuth PKCE for browser login.',
      confidence: 0.86,
      tags: ['auth', 'oauth'],
      sourceLinks: ['api/auth.ts'],
    },
    {
      kind: 'risk',
      title: 'Callback state validation must stay strict',
      summary: 'Callback state validation is security-sensitive.',
      content: 'Risk: callback state validation must remain strict.',
      confidence: 0.82,
      tags: ['auth', 'security'],
      sourceLinks: ['api/auth.ts'],
    },
  ],
  handoffs: [
    {
      signalTitle: 'Callback state validation must stay strict',
      targetNodeId: 'action_profile_1',
      relation: 'constrains',
      confidence: 0.78,
      reason: 'The downstream profile step depends on authenticated session state.',
    },
  ],
  warnings: [],
}))
const extraction = await agentService.processAgentLoop({ projectId, loopRecord: loop, actorId: userId })
expect('orchestrator persists agentic signals', extraction.signalCount === 2)
const signalIndexAfterAgent = contextService.getCoordinatesContextIndex(projectId)
const loopSignals = signalIndexAfterAgent.signals.filter((signal) => signal.sourceId === loop.id)
expect('agentic extraction creates high-value context signals', loopSignals.length >= 1 && loopSignals.length <= 5)
expect('signal classification detects risk or decision', loopSignals.some((signal) => signal.kind === 'risk' || signal.kind === 'decision'))
expect('agent loop does not expose tool-completed noise as signals', loopSignals.every((signal) => !/^Tool\s+tool_/i.test(signal.title)))
expect('agent loop does not expose touched-files noise as signals', loopSignals.every((signal) => !/^Touched files/i.test(signal.title)))
const pendingHandoff = signalIndexAfterAgent.disclosureSuggestions.find(
  (suggestion) => suggestion.sourceNodeId === 'action_login_1' && suggestion.targetNodeId === 'action_profile_1' && suggestion.status === 'pending',
)
expect('dependency target receives pending handoff suggestion', !!pendingHandoff)
if (!pendingHandoff) throw new Error('pendingHandoff not found')
const accepted = contextService.acceptDisclosureSuggestion(pendingHandoff.id, userId)
expect('accept disclosure updates status', accepted.status === 'accepted')
const acceptedNodeContext = contextService.getNodeContext(projectId, 'action_profile_1')
expect('accept disclosure creates target input binding', acceptedNodeContext.bindings.some((item) => item.blockId === loopSignals[0].blockId))
const manualShare = contextService.shareContextSignal({
  projectId,
  signalId: loopSignals[0].id,
  targetNodeId: 'project-root',
  actorId: userId,
})
expect('share creates pending suggestion', manualShare.length === 1 && manualShare[0].status === 'pending')
const beforeShareBindings = contextService.getNodeContext(projectId, 'project-root').bindings.length
expect('share does not directly bind target node', beforeShareBindings === 0)
const dismissed = contextService.dismissDisclosureSuggestion(manualShare[0].id, userId)
expect('dismiss disclosure updates status', dismissed.status === 'dismissed')
const failingAgent = new SynapseContextAgentService(contextService, async () => {
  throw new Error('classifier unavailable')
})
const failedExtraction = await failingAgent.processAgentLoop({
  projectId,
  loopRecord: { ...loop, id: 'loop_failure_probe', runId: 'run_failure_probe' },
  actorId: userId,
})
expect('agent failure creates no fallback signals', failedExtraction.signalCount === 0)
expect(
  'agent failure records failure event',
  contextService.getCoordEvents(projectId, 0, 500).some((event) => event.type === 'context_signal_extraction_failed'),
)
const synapseContext = contextService.getSynapseContextForNode(projectId, 'action_login_1')
expect('synapse context returns produced signals', synapseContext.produced.some((item) => item.signal.id === loopSignals[0].id))

const verdict = contextService.recordRunVerdict({
  projectId,
  nodeId: 'action_login_1',
  runId: 'run_smoke_1',
  verdict: 'rejected',
  note: 'Need stricter state validation.',
  reasons: ['logic'],
  actorId: userId,
})
expect('verdict block created', verdict.kind === 'correction')

const nodeContext = contextService.getNodeContext(projectId, 'action_login_1')
expect('node context aggregates bindings', nodeContext.blocks.length >= 2)

const suggestions = contextService.suggestContextBlocks({ projectId, nodeId: 'action_login_1', runId: 'run_smoke_1' })
expect('suggestions return array', Array.isArray(suggestions))

const index2 = contextService.getCoordinatesContextIndex(projectId)
expect('context index includes loop records', index2.loopRecords.some((item) => item.id === loop.id))

console.log('coordinates-context smoke passed')
