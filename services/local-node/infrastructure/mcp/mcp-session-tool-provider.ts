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
const PERSISTED_MCP_TOOLS_VERSION = 1;
const PERSISTED_MCP_TOOLS_KEY = 'mcpToolDefinitions';
const MAX_PERSISTED_TOOLS_PER_SERVER = 256;
const MAX_PERSISTED_TOOL_BYTES = 16 * 1024;
const MAX_PERSISTED_SERVER_BYTES = 128 * 1024;
const MAX_PERSISTED_TOTAL_BYTES = 512 * 1024;
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

type PersistedMcpToolDefinitions = {
  version: typeof PERSISTED_MCP_TOOLS_VERSION;
  servers: Record<string, McpRuntimeToolDef[]>;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function persistedTool(value: unknown): McpRuntimeToolDef | null {
  if (!record(value) || typeof value.name !== 'string' || !value.name) return null;
  const tool: McpRuntimeToolDef = { name: value.name };
  if (typeof value.title === 'string') tool.title = value.title;
  if (typeof value.description === 'string') tool.description = value.description;
  if (value.readOnlyHint === true) tool.readOnlyHint = true;
  if (record(value.inputSchema)) tool.inputSchema = value.inputSchema;
  if (record(value.outputSchema)) tool.outputSchema = value.outputSchema;
  return tool;
}

function readPersistedTools(sessionId: string): Record<string, McpRuntimeToolDef[]> {
  const value = agentRuntimeStore.getSession(sessionId).sessionMetadata?.[PERSISTED_MCP_TOOLS_KEY];
  if (!record(value) || value.version !== PERSISTED_MCP_TOOLS_VERSION || !record(value.servers)) return {};
  const servers: Record<string, McpRuntimeToolDef[]> = {};
  let totalBytes = 0;
  for (const [serverId, tools] of Object.entries(value.servers)) {
    if (!Array.isArray(tools)) continue;
    const parsed = tools.map(persistedTool).filter((tool): tool is McpRuntimeToolDef => Boolean(tool));
    const bounded = boundTools(parsed);
    const size = Buffer.byteLength(JSON.stringify(bounded));
    if (totalBytes + size > MAX_PERSISTED_TOTAL_BYTES) continue;
    totalBytes += size;
    if (bounded.length) servers[serverId] = bounded;
  }
  return servers;
}

function boundTools(tools: McpRuntimeToolDef[]): McpRuntimeToolDef[] {
  let bytes = 0;
  const bounded: McpRuntimeToolDef[] = [];
  for (const tool of tools.slice(0, MAX_PERSISTED_TOOLS_PER_SERVER)) {
    const compact: McpRuntimeToolDef = {
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description.slice(0, 4_000) } : {}),
      ...(tool.readOnlyHint ? { readOnlyHint: true } : {}),
    };
    const candidate = Buffer.byteLength(JSON.stringify(tool)) <= MAX_PERSISTED_TOOL_BYTES ? tool : compact;
    const size = Buffer.byteLength(JSON.stringify(candidate));
    if (size > MAX_PERSISTED_TOOL_BYTES || bytes + size > MAX_PERSISTED_SERVER_BYTES) continue;
    bytes += size;
    bounded.push(candidate);
  }
  return bounded;
}

function boundServers(serverId: string, servers: Record<string, McpRuntimeToolDef[]>): Record<string, McpRuntimeToolDef[]> {
  let bytes = 0;
  const ordered = [
    [serverId, servers[serverId]] as const,
    ...Object.entries(servers).filter(([id]) => id !== serverId),
  ];
  const bounded: Record<string, McpRuntimeToolDef[]> = {};
  for (const [id, tools] of ordered) {
    if (!tools?.length) continue;
    const size = Buffer.byteLength(JSON.stringify(tools));
    if (bytes + size > MAX_PERSISTED_TOTAL_BYTES) continue;
    bounded[id] = tools;
    bytes += size;
  }
  return bounded;
}

function readyForSession(serverId: string, projectId: string, sessionId: string): boolean {
  return mcpClientManager.isReady(serverId, projectId, sessionId);
}

/** Keep the last successful MCP discovery with the session so a process restart
 * can reconstruct the same runtime IDs before the server finishes warming up. */
function persistTools(sessionId: string, serverId: string, tools: McpRuntimeToolDef[]): void {
  const session = agentRuntimeStore.getSession(sessionId);
  const current = readPersistedTools(sessionId);
  const next = { ...current };
  if (tools.length === 0) delete next[serverId];
  else next[serverId] = boundTools(tools);
  const value: PersistedMcpToolDefinitions = {
    version: PERSISTED_MCP_TOOLS_VERSION,
    servers: boundServers(serverId, next),
  };
  if (JSON.stringify(session.sessionMetadata?.[PERSISTED_MCP_TOOLS_KEY]) === JSON.stringify(value)) return;
  agentRuntimeStore.updateSessionMetadata(sessionId, { [PERSISTED_MCP_TOOLS_KEY]: value });
}

// MCP schemas are immutable for the lifetime of a discovered tool. Keep their
// Zod identity stable across reads; replacing discovery results invalidates the
// cache naturally, without retaining old sessions or disconnected servers.
const registeredTools = new WeakMap<McpRuntimeToolDef, Map<string, RegisteredTool>>()

function buildTool(serverId: string, tool: McpRuntimeToolDef, serverName = serverId): RegisteredTool {
  const cacheKey = JSON.stringify([serverId, serverName])
  const cached = registeredTools.get(tool)?.get(cacheKey)
  if (cached) return cached
  const id = `${TOOL_PREFIX}${serverId}.${sanitizeName(tool.name)}`
  const registered: RegisteredTool = {
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
  let entries = registeredTools.get(tool)
  if (!entries) registeredTools.set(tool, entries = new Map())
  entries.set(cacheKey, registered)
  return registered
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
    const persisted = readPersistedTools(sessionId)
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
      const cached = mcpClientManager.getCachedTools(serverId, session.projectId, sessionId);
      const ready = readyForSession(serverId, session.projectId, sessionId);
      // A cold process has no in-memory discovery result yet. Reuse the last
      // successful session snapshot and let callTool reconnect lazily.
      const defs = cached.length || ready
        ? cached
        : (persisted[serverId] ?? []);
      if (cached.length || ready) persistTools(sessionId, serverId, cached);
      for (const def of defs) {
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
    for (const serverId of serverIds) {
      if (mcpClientManager.isReady(serverId, session.projectId, sessionId))
        persistTools(sessionId, serverId, mcpClientManager.getCachedTools(serverId, session.projectId, sessionId));
    }
  } catch (err) {
    logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, '[mcp] session warm-up failed')
  }
}
