import { describe, expect, it } from 'vitest';
import { createClientHandler } from '../protocol/reverse-handlers.js';

describe('unbound ACP client permissions', () => {
  it('cannot approve a tool without an explicit permission handler', async () => {
    const response = await createClientHandler().requestPermission({
      sessionId: 'discovery-session',
      toolCall: { toolCallId: 'write', kind: 'edit' },
      options: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' }],
    });
    expect(response.outcome).toEqual({ outcome: 'cancelled' });
  });
});
