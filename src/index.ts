/**
 * Synapse - Index & Re-exports
 */

// Core systems
export { SynapseEventBus, InformationBroker } from './core/event-bus.js'
export type { ReframedEvent } from './core/event-bus.js'
export { CodeFirstStateEngine } from './core/code-first-state.js'
export { runAgentLoop, createAgentState } from './core/agent-loop.js'
export type { AgentState, AgentConfig, LlmRequest, LlmEvent } from './core/agent-loop.js'

// Role system
export { RoleSlotManager, createBuiltinAgent, getAllRoleDefinitions, getRoleDefinition } from './roles/role-slot.js'

// Tool system
export { registerTool, executeTool, shouldAutoApprove, getToolSchemasForRole } from './tools/registry.js'
export type { ToolDef, ToolContext, ToolResult } from './tools/registry.js'

// Context management
export { maybeCompact, estimateTokens, snipOldToolResults, compactMessages } from './context/context-manager.js'

// Memory system
export { saveMemory, deleteMemory, loadIndex, searchMemory, getMemoryContext } from './memory/memory-store.js'
export type { MemoryEntry } from './memory/memory-store.js'

// Types
export * from './models/types.js'

// Register built-in tools (side effect import)
import './tools/builtin.js'
