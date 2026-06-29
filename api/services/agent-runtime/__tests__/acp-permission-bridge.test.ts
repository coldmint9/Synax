import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAgentRuntimeFixtures, plannerSessionInput } from './agent-runtime-fixtures.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { acpPermissionBridge } from '../acp-engine/acp-permission-bridge.js';
import { permissionPolicy } from '../permission-policy.js';
import { makeRuntimeId, nowIso } from '../runtime-ids.js';

describe('acp permission bridge', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
    acpPermissionBridge.clearTurnContext('unused');
  });

  it('auto-allows when policy allows', async () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    acpPermissionBridge.setTurnContext(session.id, {
      sessionId: session.id,
      runId: makeRuntimeId('run'),
      stepId: makeRuntimeId('step'),
      rules: session.permissionRules,
      isSubSession: false,
      onPermissionRequested: vi.fn(),
    });

    const response = await acpPermissionBridge.handleRequest({
      sessionId: session.id,
      toolCall: {
        toolCallId: 'acp_tc_1',
        kind: 'read',
        title: 'Read README',
      },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      ],
    });

    expect(response.outcome).toEqual({
      outcome: 'selected',
      optionId: 'allow_once',
    });
  });

  it('waits for user reply when policy asks', async () => {
    const session = agentSessionRuntime.create({
      ...plannerSessionInput,
      permissionTier: 'readonly',
    });
    const onPermissionRequested = vi.fn();
    acpPermissionBridge.setTurnContext(session.id, {
      sessionId: session.id,
      runId: makeRuntimeId('run'),
      stepId: makeRuntimeId('step'),
      rules: session.permissionRules,
      isSubSession: false,
      onPermissionRequested,
    });

    const pending = acpPermissionBridge.handleRequest({
      sessionId: session.id,
      toolCall: {
        toolCallId: 'acp_tc_2',
        kind: 'edit',
        title: 'Write file.ts',
      },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    });

    await Promise.resolve();
    expect(onPermissionRequested).toHaveBeenCalledTimes(1);
    const permissionId = onPermissionRequested.mock.calls[0]![0].id as string;

    permissionPolicy.reply(session.id, permissionId, 'once');
    acpPermissionBridge.resolve(session.id, permissionId, 'once');
    const response = await pending;
    expect(response.outcome).toEqual({
      outcome: 'selected',
      optionId: 'allow_once',
    });
  });
});
