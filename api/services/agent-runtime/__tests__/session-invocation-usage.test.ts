import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolCallRecord, ToolCallStatus } from '../contracts.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { resolveSessionInvocationUsage } from '../session-invocation-usage.js';
import { agentRuntimeStore } from '../session-store.js';
import { executorInput, explorerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

function appendCall(input: {
  sessionId: string;
  id: string;
  toolId: string;
  category?: ToolCallRecord['category'];
  inputRef?: unknown;
  status?: ToolCallStatus;
  startedAt?: string;
}) {
  agentRuntimeStore.appendToolCall({
    id: input.id,
    sessionId: input.sessionId,
    runId: null,
    stepId: null,
    modelToolCallId: null,
    toolId: input.toolId,
    category: input.category ?? 'read',
    mutability: 'read',
    argsHash: input.id,
    inputSummary: input.toolId,
    inputRef: input.inputRef ?? null,
    outputSummary: null,
    outputRef: null,
    status: input.status ?? 'completed',
    permissionDecisionId: null,
    startedAt: input.startedAt ?? '2026-09-21T00:00:00.000Z',
    endedAt: null,
    error: null,
  });
}

describe('resolveSessionInvocationUsage', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('normalizes tools, skills and MCP servers and sorts each group by usage', () => {
    const session = agentSessionRuntime.create(executorInput);
    appendCall({ sessionId: session.id, id: 'tool-1', toolId: 'file.read' });
    appendCall({ sessionId: session.id, id: 'tool-2', toolId: 'file.read', status: 'failed', startedAt: '2026-09-21T00:00:02.000Z' });
    appendCall({ sessionId: session.id, id: 'skill-1', toolId: 'skill.load', category: 'skill', inputRef: { skillId: 'missing/example-skill' } });
    appendCall({ sessionId: session.id, id: 'mcp-1', toolId: 'mcp.github.search', category: 'mcp' });
    appendCall({ sessionId: session.id, id: 'mcp-2', toolId: 'mcp.github.issue_get', category: 'mcp' });
    appendCall({ sessionId: session.id, id: 'invalid', toolId: 'tools.invalid' });

    expect(resolveSessionInvocationUsage(session.id)).toEqual({
      items: [
        expect.objectContaining({ kind: 'tool', id: 'file.read', label: 'Read File', callCount: 2 }),
        expect.objectContaining({ kind: 'skill', id: 'missing/example-skill', label: 'missing/example-skill', callCount: 1 }),
        expect.objectContaining({ kind: 'mcp', id: 'github', label: 'github', callCount: 2 }),
      ],
      totalCalls: 5,
    });
  });

  it('counts all persisted statuses and keeps child sessions separate', () => {
    const parent = agentSessionRuntime.create(executorInput);
    const child = agentSessionRuntime.create({ ...explorerSessionInput, parentSessionId: parent.id });
    const statuses: ToolCallStatus[] = ['pending', 'running', 'completed', 'compacted', 'failed', 'denied', 'cancelled'];
    statuses.forEach((status, index) => appendCall({ sessionId: parent.id, id: `call-${index}`, toolId: 'grep.search', status }));
    appendCall({ sessionId: child.id, id: 'child-call', toolId: 'grep.search' });

    expect(resolveSessionInvocationUsage(parent.id)).toMatchObject({
      items: [{ kind: 'tool', id: 'grep.search', callCount: 7 }],
      totalCalls: 7,
    });
  });

  it('falls back to tool usage for malformed skill and MCP records', () => {
    const session = agentSessionRuntime.create(executorInput);
    appendCall({ sessionId: session.id, id: 'skill', toolId: 'skill.load', category: 'skill', inputRef: {} });
    appendCall({ sessionId: session.id, id: 'mcp', toolId: 'mcp.invalid', category: 'mcp' });

    expect(resolveSessionInvocationUsage(session.id).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool', id: 'mcp.invalid', callCount: 1 }),
        expect.objectContaining({ kind: 'tool', id: 'skill.load', callCount: 1 }),
      ]),
    );
  });
});
