import { describe, expect, it } from 'vitest';
import { ACP_PROVIDER_IDS, isAcpProviderId } from '../acp-provider-ids.js';

describe('acp-provider-ids', () => {
  it('covers native and adapter-backed ACP runtimes', () => {
    expect(ACP_PROVIDER_IDS).toEqual(['opencode-acp', 'cursor-acp', 'codex-acp', 'pi-acp']);
  });

  it('recognizes every built-in ACP provider id', () => {
    for (const id of ACP_PROVIDER_IDS) {
      expect(isAcpProviderId(id)).toBe(true);
    }
    expect(isAcpProviderId('openai')).toBe(false);
    expect(isAcpProviderId('anthropic')).toBe(false);
    expect(isAcpProviderId('custom-api:deepseek')).toBe(false);
  });
});
