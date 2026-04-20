/**
 * Synapse API Server
 *
 * Hono-based API server providing REST + WebSocket endpoints.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'

// Import core modules (this triggers tool registration via side effects)
import './tools/builtin.js'
import { RoleSlotManager, createBuiltinAgent, getAllRoleDefinitions, getRoleDefinition } from './roles/role-slot.js'
import { runAgentLoop, createAgentState, type AgentConfig, type LlmRequest, type LlmEvent } from './core/agent-loop.js'
import { SynapseEventBus, InformationBroker } from './core/event-bus.js'
import { CodeFirstStateEngine } from './core/code-first-state.js'
import { EventType, RoleType, OccupantKind, AgentCapabilityLevel } from './models/types.js'
import { getAllTools, getToolSchemas } from './tools/registry.js'
import { getMemoryContext, searchMemory, loadIndex } from './memory/memory-store.js'

// ─── Initialize Core Systems ──────────────────────────────────────────────

const roleSlotManager = new RoleSlotManager()
const eventBus = SynapseEventBus.getInstance()
const infoBroker = new InformationBroker()
const stateEngine = new CodeFirstStateEngine()

// Demo project
const DEMO_PROJECT_ID = 'proj_demo_001'

// Create demo role slots
const demoSlots = [
  roleSlotManager.createSlot(DEMO_PROJECT_ID, RoleType.PM, createBuiltinAgent(RoleType.PM)),
  roleSlotManager.createSlot(DEMO_PROJECT_ID, RoleType.Developer, {
    kind: OccupantKind.Human,
    id: 'user_alice',
    name: 'Alice',
    email: 'alice@synapse.dev',
  }),
  roleSlotManager.createSlot(DEMO_PROJECT_ID, RoleType.QA, createBuiltinAgent(RoleType.QA)),
  roleSlotManager.createSlot(DEMO_PROJECT_ID, RoleType.Product, createBuiltinAgent(RoleType.Product)),
]

// ─── Mock LLM Provider ────────────────────────────────────────────────────

async function* mockLlmProvider(request: LlmRequest): AsyncGenerator<LlmEvent> {
  // This is a mock LLM that simulates responses for demo purposes.
  // In production, replace with actual API calls to Claude/GPT/etc.

  const lastUserMsg = [...request.messages].reverse().find(m => m.role === 'user')
  const userContent = lastUserMsg && 'content' in lastUserMsg ? lastUserMsg.content : ''

  yield { type: 'text', text: `收到消息: "${userContent.slice(0, 100)}"\n\n` }
  yield { type: 'text', text: `我是 Synapse Agent，正在分析项目状态...\n\n` }
  yield { type: 'text', text: `当前项目共有 4 个活跃角色（2 Agent + 1 Human + 1 Agent）。\n` }
  yield { type: 'text', text: `事件总线上已积累 ${eventBus.getAllEvents().length} 个事件。\n\n` }
  yield { type: 'text', text: `如需执行操作，我可以调用 TaskRead、GitStatus 等工具获取最新项目状态。` }

  yield {
    type: 'turn',
    assistant: {
      role: 'assistant',
      content: `收到消息: "${userContent.slice(0, 100)}"`,
    },
    inputTokens: 150,
    outputTokens: 80,
  }
}

// ─── API App ──────────────────────────────────────────────────────────────

const app = new Hono()

app.use('*', cors())

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', version: '0.1.0', name: 'synapse' }))

// ─── Project API ──────────────────────────────────────────────────────────

app.get('/api/projects/:projectId/roles', (c) => {
  const projectId = c.req.param('projectId')
  const slots = roleSlotManager.getSlotsByProject(projectId)
  return c.json(slots.map(s => ({
    id: s.id,
    type: s.type,
    occupant: {
      kind: s.occupant.kind,
      name: s.occupant.name,
      ...(s.occupant.kind === OccupantKind.Agent ? {
        model: (s.occupant).model,
        capabilityLevel: s.capabilityLevel,
      } : {
        email: (s.occupant).email,
      }),
    },
    capabilityLevel: s.capabilityLevel,
    switchPolicy: s.switchPolicy,
  })))
})

app.post('/api/projects/:projectId/roles/:slotId/switch', async (c) => {
  const { slotId } = c.req.param()
  const body = await c.req.json()

  const newOccupant = body.kind === 'agent'
    ? createBuiltinAgent(body.roleType as RoleType)
    : {
        kind: OccupantKind.Human,
        id: body.id ?? `user_${Date.now()}`,
        name: body.name ?? 'New Member',
        email: body.email ?? '',
      }

  const updated = roleSlotManager.switchOccupant(slotId, newOccupant, body.reason ?? 'manual')
  return c.json({ success: true, slot: updated })
})

// ─── Role Definitions ─────────────────────────────────────────────────────

app.get('/api/roles/definitions', (c) => {
  const defs = getAllRoleDefinitions()
  return c.json(Object.entries(defs).map(([type, def]) => ({
    type,
    label: def.label,
    description: def.description,
    defaultCapabilityLevel: def.defaultCapabilityLevel,
    defaultAgentTools: def.defaultAgentTools,
  })))
})

// ─── Tools API ────────────────────────────────────────────────────────────

app.get('/api/tools', (c) => {
  const tools = getAllTools()
  return c.json(tools.map(t => ({
    name: t.name,
    description: t.description,
    readOnly: t.readOnly,
    concurrentSafe: t.concurrentSafe,
    minAutoLevel: t.minAutoLevel,
  })))
})

app.get('/api/tools/schemas', (c) => {
  return c.json(getToolSchemas())
})

// ─── Events API ───────────────────────────────────────────────────────────

app.get('/api/projects/:projectId/events', (c) => {
  const projectId = c.req.param('projectId')
  const limit = parseInt(c.req.query('limit') ?? '50')
  const events = eventBus.getProjectEvents(projectId, limit)
  return c.json(events)
})

app.get('/api/events/types', (c) => {
  return c.json(Object.values(EventType))
})

// ─── State Changes API (Code-First) ───────────────────────────────────────

app.get('/api/projects/:projectId/state-changes', (c) => {
  const projectId = c.req.param('projectId')
  const changes = stateEngine.getStateChanges(projectId)
  return c.json(changes)
})

// ─── Memory API ───────────────────────────────────────────────────────────

app.get('/api/memory', (c) => {
  const scope = (c.req.query('scope') as 'user' | 'project' | 'all') ?? 'all'
  const entries = loadIndex(scope)
  return c.json(entries.map(e => ({
    name: e.name,
    description: e.description,
    type: e.type,
    scope: e.scope,
    created: e.created,
    confidence: e.confidence,
  })))
})

app.get('/api/memory/search', (c) => {
  const q = c.req.query('q') ?? ''
  const scope = (c.req.query('scope') as 'user' | 'project' | 'all') ?? 'all'
  const results = searchMemory(q, scope)
  return c.json(results.map(e => ({
    name: e.name,
    description: e.description,
    content: e.content.slice(0, 500),
    scope: e.scope,
  })))
})

// ─── Agent Chat API ───────────────────────────────────────────────────────

app.post('/api/chat', async (c) => {
  const { message, roleSlotId, projectId } = await c.req.json()

  const slot = roleSlotManager.getSlot(roleSlotId)
  if (!slot) {
    return c.json({ error: 'Role slot not found' }, 404)
  }

  if (slot.occupant.kind === OccupantKind.Human) {
    return c.json({ error: 'This role slot is occupied by a human, not an agent' }, 400)
  }

  const state = createAgentState()
  const config: AgentConfig = {
    model: 'mock-model',
    projectId: projectId ?? DEMO_PROJECT_ID,
    roleSlot: slot,
    streamLlm: mockLlmProvider,
  }

  const events = []
  for await (const event of runAgentLoop(message, state, config)) {
    events.push(event)
  }

  const textChunks = events
    .filter(e => e.type === 'text_chunk')
    .map(e => (e as { text: string }).text)
    .join('')

  return c.json({
    response: textChunks,
    turnCount: state.turnCount,
    totalTokens: state.totalInputTokens + state.totalOutputTokens,
    events: events.map(e => e.type),
  })
})

// ─── Dashboard Stats ──────────────────────────────────────────────────────

app.get('/api/projects/:projectId/stats', (c) => {
  const projectId = c.req.param('projectId')
  const slots = roleSlotManager.getSlotsByProject(projectId)
  const events = eventBus.getProjectEvents(projectId, 1000)
  const changes = stateEngine.getStateChanges(projectId)

  return c.json({
    roles: {
      total: slots.length,
      agents: slots.filter(s => s.occupant.kind === OccupantKind.Agent).length,
      humans: slots.filter(s => s.occupant.kind === OccupantKind.Human).length,
    },
    events: {
      total: events.length,
      byType: events.reduce<Record<string, number>>((acc, e) => {
        acc[e.type] = (acc[e.type] ?? 0) + 1
        return acc
      }, {}),
    },
    stateChanges: changes.length,
  })
})

// ─── Switch History ───────────────────────────────────────────────────────

app.get('/api/roles/switch-log', (c) => {
  return c.json(roleSlotManager.getSwitchLog())
})

// ─── Serve Frontend ───────────────────────────────────────────────────────

app.use('/*', serveStatic({ root: './web/dist' }))

// ─── Start ────────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? '3210')

console.log(`
╔══════════════════════════════════════════════╗
║                                              ║
║   ⚡ Synapse v0.1.0                         ║
║   Agent-Driven Project Management            ║
║                                              ║
║   API:   http://localhost:${port}/api/health  ║
║   Roles: ${demoSlots.length} initialized                      ║
║   Tools: ${getAllTools().length} registered                      ║
║                                              ║
╚══════════════════════════════════════════════╝
`)

export default {
  port,
  fetch: app.fetch,
}
