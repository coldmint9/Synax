import { effectiveTurnMcpIds } from '../agent-runtime/turn-reference-state.js';
import { z } from 'zod/v4'
import type {
  RegisteredTool,
  SessionToolProvider,
  ToolExecutionInput,
  ToolExecutionResult,
} from '../agent-runtime/contracts.js'
import { getProjectSettings } from '../../lib/config/project-settings-store.js'
import { agentRuntimeStore } from '../agent-runtime/session-store.js'
import { logger } from '../../lib/logger.js'
import { mcpClientManager, sanitizeName, type McpRuntimeToolDef } from './mcp-client-manager.js'

export const MCP_TOOL_PROVIDER_ID = 'synax-mcp'
const TOOL_PREFIX = 'mcp.'
const SUMMARY_LIMIT = 1200

function truncate(value: string): string {
  return value.length <= SUMMARY_LIMIT ? value : `${value.slice(0, SUMMARY_LIMIT)}…`
}

function parseToolId(toolId: string): { serverId: string; toolName: string } | null {
  if (!toolId.startsWith(TOOL_PREFIX)) return null
  const rest = toolId.slice(TOOL_PREFIX.length)
  const slash = rest.indexOf('.')
  if (slash <= 0 || slash >= rest.length - 1) return null
  return { serverId: rest.slice(0, slash), toolName: rest.slice(slash + 1) }
}

function buildTool(serverId: string, tool: McpRuntimeToolDef): RegisteredTool {
  const id = `${TOOL_PREFIX}${serverId}.${sanitizeName(tool.name)}`
  return {
    id,
    label: `${tool.title || tool.name} (MCP ${serverId})`,
    description: tool.description ?? `Call MCP tool ${tool.name} on server ${serverId}.`,
    category: 'mcp',
    mutability: tool.readOnlyHint ? 'read' : 'task',
    resumeBehavior: 'wait_permission',
    progressiveDetails: `Executes MCP tool ${tool.name} on configured server ${serverId}.`,
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    execute: async (input: ToolExecutionInput): Promise<ToolExecutionResult> => {
      const parsed = parseToolId(input.toolId)
      if (!parsed) {
        throw new Error(`Invalid MCP tool id: ${input.toolId}`)
      }
      const session = agentRuntimeStore.getSession(input.sessionId)
      const result = await mcpClientManager.callTool(parsed.serverId, parsed.toolName, input.args, session.projectId)
      if (!result.ok) {
        return {
          contentParts: result.contentParts,
          result: { ok: false, error: result.error ?? 'MCP tool failed' },
          displaySummary: truncate(result.error ?? 'MCP tool failed'),
          artifacts: [],
        }
      }
      return {
        contentParts: result.contentParts,
        result: { ok: true, text: result.text },
        displaySummary: truncate(result.text || '(empty result)'),
        artifacts: [],
      }
    },
  }
}

class McpSessionToolProvider implements SessionToolProvider {
  readonly id = MCP_TOOL_PROVIDER_ID

  getTools(sessionId: string): RegisteredTool[] {
    let serverIds: string[]
    try {
      const session = agentRuntimeStore.getSession(sessionId)
      serverIds = effectiveTurnMcpIds(sessionId)
    } catch {
      serverIds = []
    }
    if (serverIds.length === 0) return []

    const session = agentRuntimeStore.getSession(sessionId)
    const byId = new Map<string, import('../../lib/config/config-types.js').McpServerConfig>()
    try {
      const project = getProjectSettings(session.projectId, true)
      for (const server of project.mcpServers ?? []) byId.set(server.id, server)
    } catch { /* project settings may not exist yet */ }
    const tools: RegisteredTool[] = []
    for (const serverId of serverIds) {
      const config = byId.get(serverId)
      if (!config || config.enabled === false) continue
      for (const def of mcpClientManager.getCachedTools(serverId, session.projectId)) {
        tools.push(buildTool(serverId, def))
      }
    }
    return tools
  }

  getHooks(): never[] {
    return []
  }
}

export const mcpSessionToolProvider = new McpSessionToolProvider()

/** Await MCP server warm-up so session tools are available to the model. */
export async function warmupMcpForSession(sessionId: string): Promise<void> {
  let serverIds: string[]
  try {
    const session = agentRuntimeStore.getSession(sessionId)
    serverIds = effectiveTurnMcpIds(sessionId)
  } catch {
    serverIds = []
  }
  if (serverIds.length === 0) return
  try {
    const session = agentRuntimeStore.getSession(sessionId)
    await mcpClientManager.warmup(serverIds, session.projectId)
  } catch (err) {
    logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, '[mcp] session warm-up failed')
  }
}
