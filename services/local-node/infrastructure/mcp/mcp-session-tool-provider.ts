import { extensionStore } from '../../modules/extensions/extension-store.js';
import { effectiveTurnMcpIds } from '../../modules/agent-runtime/turn-reference-state.js';
import { z } from 'zod/v4'
import { CUA_SERVER_ID, getRuntimeCuaConfig } from './runtime-cua-config.js'
import { resolveComputerUseStrategy } from '../../modules/computer-use/strategy.js'
import { canUseDirectFallback } from '../../modules/computer-use/fallback.js'
import type {
  RegisteredTool,
  SessionToolProvider,
  ToolExecutionInput,
  ToolExecutionResult,
} from '../../modules/agent-runtime/contracts.js'
import { getProjectSettings } from '../runtime/config/project-settings-store.js'
import { agentRuntimeStore } from '../../modules/agent-runtime/session-store.js'
import { logger } from '../runtime/logger.js'
import { mcpClientManager, sanitizeName, type McpRuntimeToolDef } from './mcp-client-manager.js'
import { resolveEffectiveComputerUseSettings } from '../../modules/computer-use/effective-settings.js';

export const MCP_TOOL_PROVIDER_ID = 'synax-mcp'
const TOOL_PREFIX = 'mcp.'
const SUMMARY_LIMIT = 1200
const JEV_OBSERVATION_TOOLS = new Set(['list_apps', 'list_windows', 'get_window_state', 'get_accessibility_tree', 'get_desktop_state', 'get_screen_size']);
function cuaExposure(sessionId: string, projectId: string): 'disabled' | 'direct' | 'observation' {
  if (!getRuntimeCuaConfig()) return 'disabled';
  try {
    const settings = resolveEffectiveComputerUseSettings(projectId);
    const strategy = resolveComputerUseStrategy(settings);
    if (strategy === 'direct' || (strategy === 'jev' && settings.jev?.fallback === 'direct' && canUseDirectFallback(sessionId))) return 'direct';
    return strategy === 'jev' ? 'observation' : 'disabled';
  } catch { return 'disabled'; }
}

function truncate(value: string): string {
  return value.length <= SUMMARY_LIMIT ? value : `${value.slice(0, SUMMARY_LIMIT)}…`
}

function buildTool(serverId: string, tool: McpRuntimeToolDef, serverName = serverId): RegisteredTool {
  const id = `${TOOL_PREFIX}${serverId}.${sanitizeName(tool.name)}`
  return {
    id,
    label: `${tool.title || tool.name} (MCP ${serverName})`,
    description: tool.description ?? `Call MCP tool ${tool.name} on server ${serverId}.`,
    category: 'mcp',
    discoveryGroup: `mcp.${serverId}`,
    codeModeReadOnly: tool.readOnlyHint === true,
    mutability: tool.readOnlyHint ? 'read' : 'task',
    resumeBehavior: 'wait_permission',
    progressiveDetails: `Executes MCP tool ${tool.name} on configured server ${serverName} (${serverId}).`,
    inputSchema: (() => {
      try { return tool.inputSchema ? z.fromJSONSchema(tool.inputSchema) : z.object({}).catchall(z.unknown()); }
      catch { return z.object({}).catchall(z.unknown()); }
    })(),
    execute: async (input: ToolExecutionInput): Promise<ToolExecutionResult> => {
      if (input.toolId !== id) {
        throw new Error(`Invalid MCP tool id: ${input.toolId}`)
      }
      const session = agentRuntimeStore.getSession(input.sessionId)
      if (serverId === CUA_SERVER_ID) {
        const exposure = cuaExposure(input.sessionId, session.projectId);
        if (exposure === 'disabled' || (exposure === 'observation' && !JEV_OBSERVATION_TOOLS.has(tool.name))) {
          throw new Error('Computer Use is unavailable');
        }
      }
      // Runtime IDs are display aliases; sanitization and dotted server IDs
      // cannot be reversed to recover the original MCP protocol target.
      const result = await mcpClientManager.callTool(serverId, tool.name, input.args, session.projectId, input.sessionId, input.abortSignal)
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
    const byId = new Map<string, import('../runtime/config/config-types.js').McpServerConfig>()
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
        tools.push(buildTool(serverId, def, config.name))
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
