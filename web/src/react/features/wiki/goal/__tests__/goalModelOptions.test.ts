import { describe, expect, it } from 'vitest';
import type { GlobalConfig, ProviderDef } from '../../../../lib/contracts/config';
import { buildGoalModelOptions } from '../goalModelOptions';

const baseGlobalConfig: GlobalConfig = {
  version: 1,
  providers: [],
  defaultProviderId: 'cursor-acp',
  defaultApiProviderId: 'openai',
  enabledAcpProviderIds: ['cursor-acp'],
  providerConnections: {},
  limits: { maxAgentsPerProject: 1, agentTimeoutMs: 1 },
  features: { allowProjectConnectionOverride: true },
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'test',
};

const cursorProvider: ProviderDef = {
  id: 'cursor-acp',
  label: 'Cursor ACP',
  status: 'live',
  kind: 'acp',
  caps: { canFollowUp: true, canCancel: true },
  models: [{ id: 'cursor-default', label: 'Cursor Default', isDefault: true }],
};

describe('buildGoalModelOptions', () => {
  it('expands ACP provider models from discovery catalog', () => {
    const { acpEndpoints } = buildGoalModelOptions(
      baseGlobalConfig,
      [cursorProvider],
      [{
        id: 'cursor-acp',
        label: 'Cursor ACP',
        command: 'agent',
        status: 'available',
        installed: true,
        handshakeOk: true,
        selected: false,
        compatibility: '',
        models: [
          { id: 'auto', label: 'Auto' },
          { id: 'gpt-5.4', label: 'GPT-5.4' },
        ],
      }],
    );

    expect(acpEndpoints).toEqual([
      { kind: 'acp', providerId: 'cursor-acp', modelId: 'auto', label: 'Auto' },
      { kind: 'acp', providerId: 'cursor-acp', modelId: 'gpt-5.4', label: 'GPT-5.4' },
    ]);
  });
});
