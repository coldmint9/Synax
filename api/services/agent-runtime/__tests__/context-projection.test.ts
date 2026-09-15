import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../context-tokenizer.js', () => ({
  countMessagesTokens: (messages: unknown[]) => JSON.stringify(messages).length,
  countTokens: (text: string) => text.length,
}));
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { workRuntime } from '../work-runtime.js';
import { workStore } from '../work-store.js';
import { projectWorkContext } from '../context-projection.js';
import { buildLoopModelMessages } from '../loop-model-messages.js';
import { resetAgentRuntimeFixtures, executorInput } from './agent-runtime-fixtures.js';
import { buildLoopToolSet } from '../loop-ai-tools.js';

beforeEach(resetAgentRuntimeFixtures);
const toolSet = buildLoopToolSet([]);
function fixture() {
  const session = agentSessionRuntime.create(executorInput);
  store.appendMessage({ id: 'u', sessionId: session.id, runId: null, stepId: null, role: 'user', content: 'Investigate and retain evidence', metadata: { source: 'turn_request' }, createdAt: '2026-09-13T00:00:00Z' });
  const run = store.appendRun({ id: 'run', sessionId: session.id, status: 'running', startedAt: '2026-09-13T00:00:00Z', completedAt: null, triggerMessageId: 'u', currentStep: 6, model: null, stopReason: null, metadata: {} });
  store.updateSession(session.id, { status: 'running', activeRunId: run.id });
  const work = workRuntime.attach(session.id, run);
  for (let n = 1; n <= 6; n++) {
    store.appendRunStep({ id: `step-${n}`, runId: run.id, sessionId: session.id, index: n, status: 'completed', model: null, startedAt: `2026-09-13T00:00:0${n}Z`, completedAt: `2026-09-13T00:00:0${n}Z`, finishReason: 'tool-calls', metadata: { workId: work.id, reasoningParts: [{ text: `private-thought-${n} ` + 'x'.repeat(2000), providerMetadata: { anthropic: { signature: `signature-${n}` } } }] } });
    store.appendRunPart({ id: `p-${n}`, sessionId: session.id, runId: run.id, stepId: `step-${n}`, kind: 'thought', sequence: 1, content: `private-thought-${n} ` + 'x'.repeat(2000), toolCallId: null, metadata: {}, createdAt: `2026-09-13T00:00:0${n}Z` });
    store.appendRunPart({ id: `t-${n}`, sessionId: session.id, runId: run.id, stepId: `step-${n}`, kind: 'text', sequence: 2, content: `Finding ${n}, reference p-${n}`, toolCallId: null, metadata: {}, createdAt: `2026-09-13T00:00:0${n}Z` });
  }
  return session.id;
}
describe('persistent work context projection', () => {
  it('uses a durable boundary and never reconstructs covered reasoning on following requests', () => {
    const sessionId = fixture();
    const input = { sessionId, toolSet, contextLimit: 12000, outputReserve: 2000, systemTokens: 100 };
    const first = projectWorkContext(input);
    expect(first.compacted).toBe(true);
    expect(workStore.current(sessionId)?.checkpoint?.throughStepId).toBeTruthy();
    expect(JSON.stringify(first.messages)).not.toContain('private-thought-1');
    expect(JSON.stringify(first.messages)).toContain('signature-6');
    expect(JSON.stringify(first.messages)).toContain('Finding 1');
    const again = projectWorkContext(input);
    expect(again.messages).toEqual(first.messages);
    expect(again.compacted).toBe(false);
    expect(store.listRunParts('step-1')[0].content).toContain('private-thought-1');
  });
  it('blocks an unsafe window rather than stripping mandatory chain fields', () => {
    const sessionId = fixture();
    expect(() => projectWorkContext({ sessionId, toolSet, contextLimit: 1000, outputReserve: 500, systemTokens: 200 })).toThrow('context_blocked');
  });
  it('retains signed tool-call metadata and matching results', () => {
    const sessionId = fixture();
    store.updateRunStep('step-6', { metadata: { ...store.getRunStep('step-6').metadata, toolCallProviderMetadata: { call6: { google: { thoughtSignature: 'opaque-signature' } } } } });
    store.appendToolCall({ id: 'tc6', sessionId, runId: 'run', stepId: 'step-6', modelToolCallId: 'call6', toolId: 'file.read', category: 'read', mutability: 'read', argsHash: 'hash', inputRef: { path: 'source.ts' }, inputSummary: '', outputRef: { text: 'source' }, outputSummary: 'source', status: 'completed', permissionDecisionId: null, startedAt: '2026-09-13T00:00:06Z', endedAt: '2026-09-13T00:00:06Z', error: null });
    store.appendRunPart({ id: 'call-part', sessionId, runId: 'run', stepId: 'step-6', kind: 'tool_call', sequence: 3, content: '', toolCallId: 'tc6', metadata: {}, createdAt: '2026-09-13T00:00:06Z' });
    const messages = buildLoopModelMessages(store, sessionId, toolSet);
    const text = JSON.stringify(messages);
    expect(text).toContain('opaque-signature');
    const calls = messages.flatMap(m => Array.isArray(m.content) ? m.content as Array<{ type: string; toolCallId?: string }> : []).filter(p => p.type === 'tool-call');
    const results = messages.flatMap(m => Array.isArray(m.content) ? m.content as Array<{ type: string; toolCallId?: string }> : []).filter(p => p.type === 'tool-result');
    expect(calls).toHaveLength(1); expect(results).toHaveLength(1);
    expect((calls[0] as any).toolCallId).toBe((results[0] as any).toolCallId);
  });
});


describe('completed conversation follow-ups', () => {
  it.each([false, true])('preserves history across Work boundaries (compressed=%s)', (compressed) => {
    const sessionId = fixture();
    const input = { sessionId, toolSet, contextLimit: compressed ? 12000 : 100000, outputReserve: 2000, systemTokens: 100 };
    const before = projectWorkContext(input);
    expect(before.compacted).toBe(compressed);
    const previous = workStore.current(sessionId)!;
    previous.status = 'completed';
    workStore.save(previous);
    store.updateRun('run', { status: 'completed' });
    store.updateSession(sessionId, { status: 'completed', activeRunId: null });
    store.appendMessage({ id: 'follow-up', sessionId, runId: null, stepId: null, role: 'user', content: 'Explain the earlier findings', metadata: { source: 'turn_request' }, createdAt: '2026-09-13T00:01:00Z' });
    const run = store.appendRun({ id: 'next-run', sessionId, status: 'running', startedAt: '2026-09-13T00:01:00Z', completedAt: null, triggerMessageId: 'follow-up', currentStep: 0, model: null, stopReason: null, metadata: {} });
    const next = workRuntime.attach(sessionId, run);
    expect(next.id).not.toBe(previous.id);
    expect(next.checkpoint).toBeNull();
    const after = projectWorkContext({ ...input, contextLimit: 100000 });
    expect(after.messages).toEqual([...before.messages, { role: 'user', content: 'Explain the earlier findings' }]);
    expect(after.compacted).toBe(false);
    expect(projectWorkContext({ ...input, contextLimit: 100000 }).messages).toEqual(after.messages);
  });
});
