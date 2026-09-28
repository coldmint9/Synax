import { extensionStore } from '../extensions/extension-store.js';
import { effectiveTurnMcpIds } from '../agent-runtime/turn-reference-state.js';
import { z } from 'zod/v4'
import { CUA_SERVER_ID, getRuntimeCuaConfig } from './runtime-cua-config.js'
import { resolveComputerUseStrategy } from '../computer-use/strategy.js'
import { canUseDirectFallback } from '../computer-use/fallback.js'
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
const JEV_OBSERVATION_TOOLS = new Set(['list_apps', 'list_windows', 'get_window_state', 'get_accessibility_tree', 'get_desktop_state', 'get_screen_size']);
function cuaExposure(sessionId: string, projectId: string): 'disabled' | 'direct' | 'observation' {
  if (!getRuntimeCuaConfig()) return 'disabled';
  try {
    const settings = getProjectSettings(projectId).computerUse;
    const strategy = resolveComputerUseStrategy(settings);
    if (strategy === 'direct' || (strategy === 'jev' && settings.jev?.fallback === 'direct' && canUseDirectFallback(sessionId))) return 'direct';
    return strategy === 'jev' ? 'observation' : 'disabled';
  } catch { return 'disabled'; }
}

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
    inputSchema: (() => {
      try { return tool.inputSchema ? z.fromJSONSchema(tool.inputSchema) : z.object({}).catchall(z.unknown()); }
      catch { return z.object({}).catchall(z.unknown()); }
    })(),
    execute: async (input: ToolExecutionInput): Promise<ToolExecutionResult> => {
      const parsed = parseToolId(input.toolId)
      if (!parsed) {
        throw new Error(`Invalid MCP tool id: ${input.toolId}`)
      }
      const session = agentRuntimeStore.getSession(input.sessionId)
      const result = await mcpClientManager.callTool(parsed.serverId, parsed.toolName, input.args, session.projectId, input.sessionId, input.abortSignal)
      if (!result.ok) {
        return {
          contentParts: result.contentParts,
          result: { ok: false, error: result.error ?? 'MCP tool failed', structuredContent: result.structuredContent },
          displaySummary: truncate(result.error ?? 'MCP tool failed'),
          artifacts: [],
        }
      }
      return {
        contentParts: result.contentParts,
        result: { ok: true, text: result.text, structuredContent: result.structuredContent },
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
      if (cuaExposure(sessionId, session.projectId) !== 'disabled')
        serverIds = [...new Set([...serverIds, CUA_SERVER_ID])];
    } catch {
      serverIds = []
    }
    if (serverIds.length === 0) return []

    const session = agentRuntimeStore.getSession(sessionId)
    const byId = new Map<string, import('../../lib/config/config-types.js').McpServerConfig>()
    try {
      const project = getProjectSettings(session.projectId, true)
      for (const server of project.mcpServers ?? []) byId.set(server.id, server)
      const cua = getRuntimeCuaConfig();
      if (cua) byId.set(CUA_SERVER_ID, cua)
    } catch { /* project settings may not exist yet */ }
    const tools: RegisteredTool[] = []
    for (const serverId of serverIds) {
      const config = byId.get(serverId)
      if (!config || config.enabled === false || (serverId !== CUA_SERVER_ID && !extensionStore.active(session.projectId, 'mcp', serverId))) continue
      const exposure = serverId === CUA_SERVER_ID ? cuaExposure(sessionId, session.projectId) : 'direct';
      if (exposure === 'disabled') continue;
      for (const def of mcpClientManager.getCachedTools(serverId, session.projectId, sessionId)) {
        if (exposure === 'observation' && !JEV_OBSERVATION_TOOLS.has(def.name)) continue;
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
    if (cuaExposure(sessionId, session.projectId) !== 'disabled')
      serverIds = [...new Set([...serverIds, CUA_SERVER_ID])];
  } catch {
    serverIds = []
  }
  if (serverIds.length === 0) return
  try {
    const session = agentRuntimeStore.getSession(sessionId)
    await mcpClientManager.warmup(serverIds, session.projectId, sessionId)
  } catch (err) {
    logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, '[mcp] session warm-up failed')
  }
}
