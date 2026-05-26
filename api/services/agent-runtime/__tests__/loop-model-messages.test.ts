import { describe, it, expect } from 'vitest';
import { buildLoopModelMessages } from '../loop-model-messages.js';

function createMockStore(data: {
  messages?: Array<{ id: string; role: string; content: string }>;
  runs?: Array<{ id: string; triggerMessageId: string; startedAt: string }>;
  steps?: Array<{ id: string; runId: string; index: number }>;
  parts?: Array<{ id: string; stepId: string; kind: string; content: string; toolCallId?: string }>;
  toolCalls?: Array<{
    id: string; runId: string; stepId: string; toolId: string;
    modelToolCallId?: string; status: string;
    inputRef?: unknown; outputRef?: unknown; outputSummary?: string;
    error?: string; inputSummary?: string;
  }>;
}) {
  return {
    listMessages: (sessionId: string) => data.messages ?? [],
    listRuns: (sessionId: string) => data.runs ?? [],
    listRunSteps: (runId: string) => (data.steps ?? []).filter(s => s.runId === runId),
    listRunToolCalls: (runId: string) => (data.toolCalls ?? []).filter(tc => tc.runId === runId),
    listRunParts: (stepId: string) => (data.parts ?? []).filter(p => p.stepId === stepId),
  } as any;
}

const mockToolSet = {
  resolveModelToolName: (toolId: string) => toolId,
};

describe('buildLoopModelMessages', () => {
  it('filters out tool_results without matching tool_use in assistant content', () => {
    const store = createMockStore({
      messages: [{ id: 'msg1', role: 'user', content: 'hello' }],
      runs: [{ id: 'run1', triggerMessageId: 'msg1', startedAt: '2026-01-01T00:00:00Z' }],
      steps: [{ id: 'step1', runId: 'run1', index: 1 }],
      parts: [
        { id: 'p1', stepId: 'step1', kind: 'text', content: 'thinking...' },
      ],
      toolCalls: [
        {
          id: 'tc1', runId: 'run1', stepId: 'step1', toolId: 'file.read',
          modelToolCallId: 'call_00_orphaned', status: 'completed',
          outputRef: 'file content', inputRef: { path: '/foo' },
        },
      ],
    });

    const messages = buildLoopModelMessages(store, 'session1', mockToolSet);

    const toolMessages = messages.filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(0);

    const assistantMessages = messages.filter(m => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    const content = assistantMessages[0].content as any[];
    expect(content.every((c: any) => c.type !== 'tool-call')).toBe(true);
  });

  it('includes tool_results that have matching tool_use in assistant content', () => {
    const store = createMockStore({
      messages: [{ id: 'msg1', role: 'user', content: 'hello' }],
      runs: [{ id: 'run1', triggerMessageId: 'msg1', startedAt: '2026-01-01T00:00:00Z' }],
      steps: [{ id: 'step1', runId: 'run1', index: 1 }],
      parts: [
        { id: 'p1', stepId: 'step1', kind: 'tool_call', content: '', toolCallId: 'tc1' },
      ],
      toolCalls: [
        {
          id: 'tc1', runId: 'run1', stepId: 'step1', toolId: 'file.read',
          modelToolCallId: 'call_00_valid', status: 'completed',
          outputRef: 'file content', inputRef: { path: '/foo' },
        },
      ],
    });

    const messages = buildLoopModelMessages(store, 'session1', mockToolSet);

    const assistantMessages = messages.filter(m => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    const content = assistantMessages[0].content as any[];
    expect(content.some((c: any) => c.type === 'tool-call' && c.toolCallId === 'call_00_valid')).toBe(true);

    const toolMessages = messages.filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const toolContent = toolMessages[0].content as any[];
    expect(toolContent[0].toolCallId).toBe('call_00_valid');
  });

  it('handles resume scenario: mixed valid and orphaned tool calls', () => {
    const store = createMockStore({
      messages: [{ id: 'msg1', role: 'user', content: 'hello' }],
      runs: [{ id: 'run1', triggerMessageId: 'msg1', startedAt: '2026-01-01T00:00:00Z' }],
      steps: [{ id: 'step1', runId: 'run1', index: 1 }],
      parts: [
        { id: 'p1', stepId: 'step1', kind: 'tool_call', content: '', toolCallId: 'tc1' },
      ],
      toolCalls: [
        {
          id: 'tc1', runId: 'run1', stepId: 'step1', toolId: 'file.read',
          modelToolCallId: 'call_00_valid', status: 'completed',
          outputRef: 'content1', inputRef: { path: '/a' },
        },
        {
          id: 'tc2', runId: 'run1', stepId: 'step1', toolId: 'file.read',
          modelToolCallId: 'call_00_orphaned', status: 'completed',
          outputRef: 'content2', inputRef: { path: '/b' },
        },
      ],
    });

    const messages = buildLoopModelMessages(store, 'session1', mockToolSet);

    const toolMessages = messages.filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const toolContent = toolMessages[0].content as any[];
    expect(toolContent).toHaveLength(1);
    expect(toolContent[0].toolCallId).toBe('call_00_valid');
  });
});
