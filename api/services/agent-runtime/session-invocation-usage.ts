import { getProjectSettings } from '../../lib/config/project-settings-store.js';
import { skillRegistry } from '../skills/index.js';
import type { ToolCallRecord } from './contracts.js';
import { agentRuntimeStore } from './session-store.js';
import { toolRegistry } from './tool-registry.js';

export type SessionInvocationKind = 'tool' | 'skill' | 'mcp';

export interface SessionInvocationUsageItem {
  kind: SessionInvocationKind;
  id: string;
  label: string;
  callCount: number;
  lastCalledAt: string;
}

export interface SessionInvocationUsageResponse {
  items: SessionInvocationUsageItem[];
  totalCalls: number;
}

const KIND_ORDER: Record<SessionInvocationKind, number> = {
  tool: 0,
  skill: 1,
  mcp: 2,
};

function readableId(id: string): string {
  return id
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || id;
}

function skillIdFromCall(call: Pick<ToolCallRecord, "toolId" | "inputRef">): string | null {
  if (call.toolId !== 'skill.load' || !call.inputRef || typeof call.inputRef !== 'object') return null;
  const skillId = (call.inputRef as { skillId?: unknown }).skillId;
  return typeof skillId === 'string' && skillId.trim() ? skillId.trim() : null;
}

function mcpServerIdFromCall(call: Pick<ToolCallRecord, "toolId" | "category">): string | null {
  if (call.category !== 'mcp' || !call.toolId.startsWith('mcp.')) return null;
  const rest = call.toolId.slice('mcp.'.length);
  const separator = rest.indexOf('.');
  return separator > 0 && separator < rest.length - 1 ? rest.slice(0, separator) : null;
}

function toolLabel(sessionId: string, toolId: string): string {
  try {
    return toolRegistry.getForSession(sessionId, toolId).label;
  } catch {
    return readableId(toolId);
  }
}

export function resolveSessionInvocationUsage(sessionId: string): SessionInvocationUsageResponse {
  const session = agentRuntimeStore.getSession(sessionId);
  const calls = agentRuntimeStore.listToolInvocationRows(sessionId);
  const usage = new Map<string, SessionInvocationUsageItem>();
  for (const call of calls) {
    if (call.toolId === 'tools.invalid') continue;
    const skillId = skillIdFromCall(call), serverId = mcpServerIdFromCall(call);
    const kind: SessionInvocationKind = skillId ? 'skill' : serverId ? 'mcp' : 'tool';
    const id = skillId ?? serverId ?? call.toolId;
    const key = `${kind}:${id}`;
    const existing = usage.get(key);
    if (existing) {
      existing.callCount++;
      if (call.startedAt > existing.lastCalledAt) existing.lastCalledAt = call.startedAt;
    } else usage.set(key, { kind, id, label: '', callCount: 1, lastCalledAt: call.startedAt });
  }

  // Resolve each distinct identity once, not once per historical invocation.
  // Skip project settings entirely for sessions without MCP calls.
  const mcpNames = new Map<string, string>();
  if ([...usage.values()].some(item => item.kind === 'mcp')) {
    try {
      for (const server of getProjectSettings(session.projectId).mcpServers ?? [])
        mcpNames.set(server.id, server.name?.trim() || server.id);
    } catch { /* Historical statistics survive removed project settings. */ }
  }
  for (const item of usage.values()) {
    if (item.kind === 'tool') item.label = toolLabel(sessionId, item.id);
    else if (item.kind === 'mcp') item.label = mcpNames.get(item.id) ?? item.id;
    else {
      try { item.label = skillRegistry.getSummary(item.id, session.projectId).label.trim() || item.id; }
      catch { item.label = item.id; }
    }
  }

  const items = [...usage.values()].sort((a, b) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || b.callCount - a.callCount
    || b.lastCalledAt.localeCompare(a.lastCalledAt)
    || a.label.localeCompare(b.label),
  );
  return {
    items,
    totalCalls: items.reduce((total, item) => total + item.callCount, 0),
  };
}
