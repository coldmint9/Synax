import { agentRuntimeStore } from '../session-store.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAgentRuntimeFixtures, plannerSessionInput } from './agent-runtime-fixtures.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { AcpPermissionBridge, acpPermissionBridge } from '../acp-engine/acp-permission-bridge.js';
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


describe('ACP permission identity and scope', () => {
  beforeEach(() => resetAgentRuntimeFixtures());

  it('fails closed when no turn owns the native permission request', async () => {
    const bridge = new AcpPermissionBridge();
    const response = await bridge.handleRequest({
      sessionId: 'unknown-native-session',
      toolCall: { toolCallId: 'tool-unknown', kind: 'edit', title: 'Edit file' },
      options: [{ optionId: 'approve', kind: 'allow_once', name: 'Approve' }],
    });
    expect(response.outcome).toEqual({ outcome: 'cancelled' });
  });

  it('binds different Synax/native IDs and rejects a stale native session', async () => {
    const bridge = new AcpPermissionBridge();
    const session = agentSessionRuntime.create({ ...plannerSessionInput, permissionTier: 'readonly' });
    const requested = vi.fn();
    bridge.setTurnContext(session.id, {
      sessionId: session.id, acpSessionId: 'native-current',
      runId: makeRuntimeId('run'), stepId: makeRuntimeId('step'),
      rules: session.permissionRules, isSubSession: false, onPermissionRequested: requested,
    });
    const request = {
      sessionId: 'native-current',
      toolCall: { toolCallId: 'native-edit', kind: 'edit' as const, title: 'Write file.ts' },
      options: [{ optionId: 'approve', kind: 'allow_once' as const, name: 'Approve' }],
    };
    expect((await bridge.handleRequest({ ...request, sessionId: 'native-stale' }, session.id)).outcome)
      .toEqual({ outcome: 'cancelled' });
    const pending = bridge.handleRequest(request, session.id);
    await Promise.resolve();
    expect(requested).toHaveBeenCalledTimes(1);
    const permissionId = requested.mock.calls[0]![0].id as string;
    expect(bridge.resolve('other-session', permissionId, 'once')).toBe(false);
    bridge.clearTurnContext(session.id);
    expect((await pending).outcome).toEqual({ outcome: 'cancelled' });
    expect(bridge.resolve(session.id, permissionId, 'once')).toBe(false);
    expect(agentRuntimeStore.listPermissions(session.id).find(item => item.id === permissionId))
      .toMatchObject({ action: 'deny', userReply: 'reject', resolvedAt: expect.any(String) });
  });

  it('never escalates an allow-once decision to persistent permission', async () => {
    const bridge = new AcpPermissionBridge();
    const session = agentSessionRuntime.create(plannerSessionInput);
    bridge.setTurnContext(session.id, {
      sessionId: session.id, runId: makeRuntimeId('run'), stepId: makeRuntimeId('step'),
      rules: session.permissionRules, isSubSession: false, onPermissionRequested: vi.fn(),
    });
    const response = await bridge.handleRequest({
      sessionId: session.id,
      toolCall: { toolCallId: 'read', kind: 'read', title: 'Read file' },
      options: [{ optionId: 'all', kind: 'allow_always', name: 'Always allow' }],
    });
    expect(response.outcome).toEqual({ outcome: 'cancelled' });
  });
});
