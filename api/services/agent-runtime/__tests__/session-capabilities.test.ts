import { beforeEach, describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { resolveSessionCapabilities } from '../session-capabilities.js';
import { toolRegistry } from '../tool-registry.js';
import { wikiAgentToolProvider } from '../../wiki/wiki-agent-tool-provider.js';
import { explorerSessionInput, executorInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('resolveSessionCapabilities', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
    toolRegistry.registerProvider(wikiAgentToolProvider);
  });

  it('returns profile-scoped tools and active skills for explorer sessions', () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const caps = resolveSessionCapabilities(session.id);

    expect(caps.profile.id).toBe('explorer');
    expect(caps.tools.available.map((tool) => tool.id)).toEqual(
      expect.arrayContaining([
        'bash',
        'file.glob',
        'grep.search',
        'skill.load',
        'wiki.search_content',
        'wiki.search_batch',
        'wiki.read_section',
      ]),
    );
    expect(caps.tools.available.some((tool) => tool.id === 'file.write')).toBe(false);
    expect(caps.skills.active.map((skill) => skill.id)).toEqual(['code-explorer']);
    expect(caps.skills.candidates.map((skill) => skill.id)).toEqual(['code-explorer']);
  });

  it('hides write tools for executor until disclosure is escalated', () => {
    const session = agentSessionRuntime.create(executorInput);
    const beforeEscalation = resolveSessionCapabilities(session.id);
    expect(beforeEscalation.tools.visible.some((tool) => tool.id === 'file.write')).toBe(false);
    expect(beforeEscalation.tools.visible.some((tool) => tool.id === 'task.create')).toBe(true);
    expect(beforeEscalation.tools.available.some((tool) => tool.id === 'file.write')).toBe(true);

    agentRuntimeStore.appendToolCall({
      id: 'tc_escalate',
      sessionId: session.id,
      runId: null,
      stepId: null,
      toolId: 'tools.escalate',
      category: 'context',
      mutability: 'read',
      inputSummary: 'ready to write',
      outputSummary: null,
      status: 'completed',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: null,
    });

    const afterEscalation = resolveSessionCapabilities(session.id);
    expect(afterEscalation.tools.visible.some((tool) => tool.id === 'file.write')).toBe(true);
  });
});
