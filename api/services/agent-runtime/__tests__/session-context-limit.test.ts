import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../llm-runtime/gateway.js', () => ({
  resolveGatewaySelection: vi.fn(async () => ({ modelDef: { contextLimit: 1_000_000 } })),
}));

import { resolveGatewaySelection } from '../../llm-runtime/gateway.js';
import {
  resetSessionContextLimitCacheForTests,
  resolveSessionConfiguredContextLimit,
} from '../session-context-limit.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { explorerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

const mockResolveGatewaySelection = vi.mocked(resolveGatewaySelection);

describe('resolveSessionConfiguredContextLimit', () => {
  beforeEach(() => {
    resetAgentRuntimeFixtures();
    resetSessionContextLimitCacheForTests();
    mockResolveGatewaySelection.mockReset();
    mockResolveGatewaySelection.mockResolvedValue({
      modelDef: { contextLimit: 1_000_000 },
    } as Awaited<ReturnType<typeof resolveGatewaySelection>>);
  });

  it('returns the provider-configured context window', async () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    await expect(resolveSessionConfiguredContextLimit(session)).resolves.toBe(1_000_000);
  });

  it('caches the resolution per session', async () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    await resolveSessionConfiguredContextLimit(session);
    await resolveSessionConfiguredContextLimit(session);
    expect(mockResolveGatewaySelection).toHaveBeenCalledTimes(1);
  });

  it('returns null when the provider has no configured window', async () => {
    mockResolveGatewaySelection.mockResolvedValueOnce({
      modelDef: {},
    } as Awaited<ReturnType<typeof resolveGatewaySelection>>);
    const session = agentSessionRuntime.create(explorerSessionInput);
    await expect(resolveSessionConfiguredContextLimit(session)).resolves.toBeNull();
  });

  it('leaves ACP sessions to the engine-reported window', async () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const updated = agentRuntimeStore.updateSession(session.id, {
      sessionMetadata: {
        acp: { providerId: 'cursor-acp', acpSessionId: 'acp-1', engineModel: 'cursor-acp/default' },
      },
    });
    await expect(resolveSessionConfiguredContextLimit(updated)).resolves.toBeNull();
    expect(mockResolveGatewaySelection).not.toHaveBeenCalled();
  });
});
