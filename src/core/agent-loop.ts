/**
 * Synapse Agent Loop Engine
 *
 * The heart of the system — an event-driven agent loop using async generators.
 *
 * Architecture derived from:
 * 1. Claude Code's query.ts → QueryEngine.submitMessage() async generator pattern
 * 2. clawspring's agent.py → run() generator with ToolStart/ToolEnd/TurnDone events
 *
 * Key innovations over the originals:
 * - Role-aware: tools are filtered and permissions checked based on RoleSlot
 * - Event-emitting: every action publishes to the EventBus for Zero-Alignment
 * - Code-First State: task status auto-derives from tool execution results
 * - Graceful degradation: agent can yield to human when confidence is low
 */

import {
  type AgentEvent,
  type Message,
  type UserMessage,
  type AssistantMessage,
  type ToolResultMessage,
  type ToolCall,
  type ProjectId,
  type RoleSlotId,
  OccupantKind,
  AgentCapabilityLevel,
} from '../models/types.js'
import { executeTool, shouldAutoApprove, getToolSchemasForRole, type ToolContext } from '../tools/registry.js'
import { maybeCompact } from '../context/context-manager.js'
import { getMemoryContext } from '../memory/memory-store.js'
import { type RoleSlot, getRoleDefinition } from '../roles/role-slot.js'
import { SynapseEventBus, EventType } from './event-bus.js'

// ─── Agent State ──────────────────────────────────────────────────────────

export interface AgentState {
  messages: Message[]
  totalInputTokens: number
  totalOutputTokens: number
  turnCount: number
  lastActivityTimestamp: number
}

export function createAgentState(): AgentState {
  return {
    messages: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
    lastActivityTimestamp: Date.now(),
  }
}

// ─── Agent Config ─────────────────────────────────────────────────────────

export interface AgentConfig {
  model: string
  projectId: ProjectId
  roleSlot: RoleSlot
  systemPrompt?: string
  maxTurns?: number
  permissionMode?: 'auto' | 'manual' | 'accept_all'
  cancelCheck?: () => boolean
  /** LLM streaming function — pluggable for different providers */
  streamLlm: (request: LlmRequest) => AsyncGenerator<LlmEvent>
}

export interface LlmRequest {
  model: string
  system: string
  messages: Message[]
  toolSchemas: Record<string, unknown>[]
}

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'turn'; assistant: AssistantMessage; inputTokens: number; outputTokens: number }
  | { type: 'error'; error: string }

// ─── Agent Loop ───────────────────────────────────────────────────────────

export async function* runAgentLoop(
  userMessage: string,
  state: AgentState,
  config: AgentConfig,
): AsyncGenerator<AgentEvent, void, unknown> {
  const { roleSlot, projectId, maxTurns = 50 } = config
  const eventBus = SynapseEventBus.getInstance()

  // Append user message
  const userMsg: UserMessage = { role: 'user', content: userMessage }
  state.messages.push(userMsg)

  // Build system prompt
  const systemPrompt = buildSystemPrompt(config)

  // Get tool schemas for this role
  const allowedTools = roleSlot.occupant.kind === OccupantKind.Agent
    ? (roleSlot.occupant).allowedTools
    : [] // Humans have access to all tools
  const toolSchemas = getToolSchemasForRole(allowedTools)

  // Emit agent started event
  eventBus.emit({
    id: `evt_${Date.now()}`,
    type: EventType.AgentStarted,
    timestamp: Date.now(),
    projectId,
    source: roleSlot.id,
    payload: { roleType: roleSlot.type, message: userMessage.slice(0, 200) },
  })

  let turnCount = 0

  while (turnCount < maxTurns) {
    if (config.cancelCheck?.()) break

    state.turnCount++
    turnCount++

    // Context compression (mirrors clawspring's maybe_compact)
    const { messages: compacted } = await maybeCompact(state.messages, { model: config.model })
    state.messages = compacted

    // Stream from LLM
    let assistantText = ''
    let toolCalls: ToolCall[] = []
    let inputTokens = 0
    let outputTokens = 0

    try {
      for await (const event of config.streamLlm({
        model: config.model,
        system: systemPrompt,
        messages: state.messages,
        toolSchemas,
      })) {
        switch (event.type) {
          case 'text':
            assistantText += event.text
            yield { type: 'text_chunk' as const, text: event.text }
            break
          case 'thinking':
            yield { type: 'thinking_chunk' as const, text: event.text }
            break
          case 'turn':
            toolCalls = event.assistant.toolCalls ?? []
            inputTokens = event.inputTokens
            outputTokens = event.outputTokens
            break
          case 'error':
            yield { type: 'text_chunk' as const, text: `[Error] ${event.error}` }
            break
        }
      }
    } catch (error) {
      yield {
        type: 'text_chunk' as const,
        text: `[Agent Error] ${error instanceof Error ? error.message : String(error)}`,
      }
      break
    }

    // Record assistant turn
    const assistantMsg: AssistantMessage = {
      role: 'assistant',
      content: assistantText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    }
    state.messages.push(assistantMsg)
    state.totalInputTokens += inputTokens
    state.totalOutputTokens += outputTokens
    state.lastActivityTimestamp = Date.now()

    yield { type: 'turn_done', inputTokens, outputTokens }

    // If no tool calls, the conversation turn is complete
    if (toolCalls.length === 0) break

    // ── Execute Tools ──────────────────────────────────────────────────
    const toolContext: ToolContext = {
      projectId,
      roleSlotId: roleSlot.id,
      capabilityLevel: roleSlot.capabilityLevel,
      workingDir: process.cwd(),
      config: {},
    }

    for (const tc of toolCalls) {
      yield { type: 'tool_start', name: tc.name, inputs: tc.input, toolCallId: tc.id }

      // Permission check
      const autoApproved = shouldAutoApprove(tc.name, toolContext)
        || config.permissionMode === 'accept_all'

      let permitted = autoApproved
      let result: string

      if (!permitted) {
        if (config.permissionMode === 'manual') {
          // Always ask in manual mode
          yield {
            type: 'permission_request',
            toolName: tc.name,
            description: formatPermissionDesc(tc),
            granted: false,
          }
          // In real implementation, this would pause and wait for user input
          // For now, deny if not auto-approved in manual mode
          result = 'Denied: permission not granted in manual mode'
        } else {
          // Default mode: ask for write operations, auto-approve reads
          yield {
            type: 'permission_request',
            toolName: tc.name,
            description: formatPermissionDesc(tc),
            granted: false, // UI would set this
          }
          // Simulate: auto-approve for Observer/Executor level if tool allows
          permitted = roleSlot.capabilityLevel >= AgentCapabilityLevel.Collaborator
          result = permitted
            ? (await executeTool(tc.name, tc.input, toolContext)).output
            : 'Denied: insufficient capability level for this operation'
        }
      } else {
        const toolResult = await executeTool(tc.name, tc.input, toolContext)
        result = toolResult.output
      }

      yield { type: 'tool_end', name: tc.name, result, toolCallId: tc.id, permitted }

      // Record tool result
      const toolMsg: ToolResultMessage = {
        role: 'tool',
        toolCallId: tc.id,
        name: tc.name,
        content: result,
      }
      state.messages.push(toolMsg)

      // Emit tool execution event for Zero-Alignment Protocol
      eventBus.emit({
        id: `evt_${Date.now()}_${tc.id}`,
        type: EventType.AgentToolCall,
        timestamp: Date.now(),
        projectId,
        source: roleSlot.id,
        payload: { toolName: tc.name, permitted, resultLength: result.length },
      })

      // Code-First State: auto-derive task status from tool results
      if (tc.name === 'TaskUpdate' && permitted) {
        eventBus.emit({
          id: `evt_${Date.now()}_state`,
          type: EventType.TaskStatusChanged,
          timestamp: Date.now(),
          projectId,
          source: roleSlot.id,
          payload: { toolName: tc.name, input: tc.input },
        })
      }

      if (tc.name === 'GitStatus' || tc.name === 'Bash') {
        // Git activity detected — emit for Code-First State derivation
        if (result.includes('branch') || result.includes('commit')) {
          eventBus.emit({
            id: `evt_${Date.now()}_git`,
            type: EventType.CommitPushed,
            timestamp: Date.now(),
            projectId,
            source: roleSlot.id,
            payload: { gitOutput: result.slice(0, 500) },
          })
        }
      }
    }
  }

  // Emit agent completed event
  eventBus.emit({
    id: `evt_${Date.now()}_done`,
    type: EventType.AgentCompleted,
    timestamp: Date.now(),
    projectId,
    source: roleSlot.id,
    payload: {
      turnCount: state.turnCount,
      totalTokens: state.totalInputTokens + state.totalOutputTokens,
    },
  })
}

// ─── System Prompt Builder ────────────────────────────────────────────────

function buildSystemPrompt(config: AgentConfig): string {
  const { roleSlot, projectId } = config
  const roleDef = getRoleDefinition(roleSlot.type)
  const occupantName = roleSlot.occupant.name
  const occupantKind = roleSlot.occupant.kind

  let prompt = `You are ${occupantName}, a ${roleDef.label} in the Synapse project management platform.

# Your Role
${roleDef.description}

# Your Capabilities
${occupantKind === OccupantKind.Agent
    ? `You are an AI Agent with capability level ${AgentCapabilityLevel[roleSlot.capabilityLevel]}.
- Level 1 (Observer): Read-only, suggest and notify
- Level 2 (Executor): Execute within predefined rules
- Level 3 (Collaborator): Propose solutions, execute after confirmation
- Level 4 (Autonomous): Fully autonomous within authorized scope

Your current level: ${AgentCapabilityLevel[roleSlot.capabilityLevel]}`
    : 'You are a human team member with full autonomy.'
  }

# Project Context
- Project ID: ${projectId}
- Date: ${new Date().toISOString().split('T')[0]}

`

  // Add agent-specific system prompt
  if (occupantKind === OccupantKind.Agent && (roleSlot.occupant).systemPrompt) {
    prompt += `\n# Specialized Instructions\n${(roleSlot.occupant).systemPrompt}\n`
  }

  // Add custom system prompt
  if (config.systemPrompt) {
    prompt += `\n# Additional Context\n${config.systemPrompt}\n`
  }

  // Add memory context
  const memoryCtx = getMemoryContext()
  if (memoryCtx) {
    prompt += `\n# Your Memories\n${memoryCtx}\n`
  }

  return prompt
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatPermissionDesc(tc: ToolCall): string {
  const { name, input } = tc
  if (name === 'Bash') return `Run: ${input.command ?? ''}`
  if (name === 'Write') return `Write to: ${input.file_path ?? ''}`
  if (name === 'Edit') return `Edit: ${input.file_path ?? ''}`
  return `${name}(${Object.values(input).slice(0, 1).join(', ')})`
}
