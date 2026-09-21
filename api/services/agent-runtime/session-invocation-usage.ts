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

function skillIdFromCall(call: ToolCallRecord): string | null {
  if (call.toolId !== 'skill.load' || !call.inputRef || typeof call.inputRef !== 'object') return null;
  const skillId = (call.inputRef as { skillId?: unknown }).skillId;
  return typeof skillId === 'string' && skillId.trim() ? skillId.trim() : null;
}

function mcpServerIdFromCall(call: ToolCallRecord): string | null {
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
  const calls = agentRuntimeStore.listToolCalls(sessionId);
  const mcpNames = new Map<string, string>();
  try {
    for (const server of getProjectSettings(session.projectId).mcpServers ?? []) {
      mcpNames.set(server.id, server.name?.trim() || server.id);
    }
  } catch {
    // Historical calls remain useful even when project settings are unavailable.
  }

  const usage = new Map<string, SessionInvocationUsageItem>();
  for (const call of calls) {
    if (call.toolId === 'tools.invalid') continue;

    let kind: SessionInvocationKind = 'tool';
    let id = call.toolId;
    let label: string;

    const skillId = skillIdFromCall(call);
    if (skillId) {
      kind = 'skill';
      id = skillId;
      try {
        label = skillRegistry.getSummary(skillId, session.projectId).label.trim() || skillId;
      } catch {
        label = skillId;
      }
    } else {
      const serverId = mcpServerIdFromCall(call);
      if (serverId) {
        kind = 'mcp';
        id = serverId;
        label = mcpNames.get(serverId) ?? serverId;
      } else {
        label = toolLabel(sessionId, call.toolId);
      }
    }

    const key = `${kind}:${id}`;
    const existing = usage.get(key);
    if (existing) {
      existing.callCount += 1;
      if (call.startedAt > existing.lastCalledAt) existing.lastCalledAt = call.startedAt;
    } else {
      usage.set(key, { kind, id, label, callCount: 1, lastCalledAt: call.startedAt });
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
