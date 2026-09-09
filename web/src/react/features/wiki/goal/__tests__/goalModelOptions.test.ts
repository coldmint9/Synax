import { describe, expect, it } from 'vitest';
import type { GlobalConfig, ProviderDef } from '../../../../lib/contracts/config';
import { buildGoalModelOptions, formatTurnModel } from '../goalModelOptions';

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

describe('formatTurnModel ACP provider/model refs', () => {
  it('formats native and adapter-backed ACP engines as providerId/modelId', () => {
    expect(formatTurnModel('codex-acp', 'gpt-5.4')).toBe('codex-acp/gpt-5.4');
    expect(formatTurnModel('pi-acp', 'default')).toBe('pi-acp/default');
    expect(formatTurnModel('cursor-acp', 'auto')).toBe('cursor-acp/auto');
    expect(formatTurnModel('openai', 'gpt-5.4')).toBe('gpt-5.4');
    expect(formatTurnModel(null, 'gpt-5.4')).toBe('gpt-5.4');
    expect(formatTurnModel('codex-acp', null)).toBeUndefined();
  });

  it('expands pi-acp endpoints from discovery catalog when enabled', () => {
    const config: GlobalConfig = {
      ...baseGlobalConfig,
      enabledAcpProviderIds: ['pi-acp'],
      defaultProviderId: 'pi-acp',
    };
    const piProvider: ProviderDef = {
      id: 'pi-acp',
      label: 'Pi ACP',
      status: 'live',
      kind: 'acp',
      caps: { canFollowUp: true, canCancel: true },
      models: [{ id: 'pi-default', label: 'Pi Default', isDefault: true }],
    };
    const { acpEndpoints } = buildGoalModelOptions(config, [piProvider], [{
      id: 'pi-acp',
      label: 'Pi ACP',
      command: 'pi-acp',
      status: 'available',
      installed: true,
      handshakeOk: true,
      selected: false,
      compatibility: '',
      models: [
        { id: 'auto', label: 'Auto' },
        { id: 'gpt-5.4', label: 'GPT-5.4' },
      ],
    }]);

    expect(acpEndpoints).toEqual([
      { kind: 'acp', providerId: 'pi-acp', modelId: 'auto', label: 'Auto' },
      { kind: 'acp', providerId: 'pi-acp', modelId: 'gpt-5.4', label: 'GPT-5.4' },
    ]);
  });
});
