import { beforeEach, describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { plannerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { resolveSessionBackend, resolveBackendModel, validateBackendTurnInput } from '../backends/backend-binding.js';
import { shouldUseAcpEngine } from '../acp-engine/acp-engine-routing.js';

beforeEach(resetAgentRuntimeFixtures);

describe('explicit execution backend binding', () => {
  it('pins new sessions to Native independently of the next model string', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    expect(resolveSessionBackend(session.id).id).toBe('native');
    expect(() => shouldUseAcpEngine(session.id, { model: 'codex-acp/default' })).toThrow(/backend/i);
  });

  it('accepts bare backend models without using them to pick the engine', () => {
    const session = agentSessionRuntime.create({ ...plannerSessionInput, backendId: 'codex-acp', model: 'default' });
    expect(shouldUseAcpEngine(session.id, { model: 'other-model' })).toBe(true);
    expect(resolveBackendModel(session.id, { model: 'other-model' })).toBe('codex-acp/other-model');
    expect(() => resolveBackendModel(session.id, { model: 'cursor-acp/default' })).toThrow(/backend/i);
  });

  it('migrates an existing native session binding without overwriting other metadata', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    agentRuntimeStore.updateSession(session.id, { sessionMetadata: { mode: 'plan', custom: 'keep' } });
    expect(resolveSessionBackend(session.id).id).toBe('native');
    expect(agentRuntimeStore.getSession(session.id).sessionMetadata?.custom).toBe('keep');
  });

  it('prefers persisted ACP identity when upgrading an unbound legacy session', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    agentRuntimeStore.updateSession(session.id, { sessionMetadata: {
      acp: { providerId: 'codex-acp', acpSessionId: 'external', engineModel: 'codex-acp/default' },
    } });
    expect(resolveSessionBackend(session.id).id).toBe('codex-acp');
    expect(resolveBackendModel(session.id, {})).toBe('codex-acp/default');
  });

  it('does not guess an execution engine from ambiguous legacy history', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    agentRuntimeStore.updateSession(session.id, { sessionMetadata: null });
    for (const [id, model] of [['old-native', 'api-model'], ['old-acp', 'codex-acp/default']]) {
      agentRuntimeStore.appendRun({ id, model, sessionId: session.id, status: 'completed',
        startedAt: new Date().toISOString(), completedAt: null, triggerMessageId: null,
        currentStep: 0, stopReason: null, metadata: {} });
    }
    expect(() => resolveSessionBackend(session.id)).toThrow(/ambiguous/i);
    expect(agentRuntimeStore.listRuns(session.id)).toHaveLength(2);
  });

  it('rejects forged or invalid persisted bindings instead of silently using Native', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    agentRuntimeStore.updateSessionMetadata(session.id, { backend: { version: 99, id: 'native' } });
    expect(() => resolveSessionBackend(session.id)).toThrow(/binding/i);
  });
});

describe('native CLI capability boundaries', () => {
  it('rejects unsupported Synax permission controls rather than recording a misleading tier', () => {
    expect(() => agentSessionRuntime.create({ ...plannerSessionInput, backendId: 'codex', permissionTier: 'boundary' })).toThrow(/own sandbox and approvals/);
    for (const backendId of ['codex', 'claude-code']) {
      expect(() => validateBackendTurnInput(backendId, { permissionTier: 'unrestricted' })).toThrow(/permission tiers/);
      expect(() => validateBackendTurnInput(backendId, { maxSteps: 5 })).toThrow(/own agent loop/);
    }
    expect(() => validateBackendTurnInput('native', { permissionTier: 'boundary', maxSteps: 5 })).not.toThrow();
  });
});
