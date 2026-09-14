import { describe, expect, it } from 'vitest';
import { wikiRoutes } from '../wiki.js';

describe('shared prompt endpoint purpose boundary', () => {
  const build = (mode: string) => wikiRoutes.request('http://localhost/projects/prompt-fixture/goals/session-prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, content: '请调查认证', wikiAttachMode: 'manual', locale: 'zh' }),
  });
  it('returns original user intent for general sessions', async () => {
    const response = await build('session');
    expect(response.status).toBe(200);
    const data = await response.json() as { prompt: string; wikiContext: unknown };
    expect(data.prompt).toBe('请调查认证');
    expect(data.wikiContext).toMatchObject({ documentId: null, mode: 'manual' });
  });
  it('preserves the explicit Wiki direct workflow protocol', async () => {
    const response = await build('direct');
    expect(response.status).toBe(200);
    const data = await response.json() as { prompt: string };
    expect(data.prompt).toContain('implement the goal');
    expect(data.prompt).toContain('## User Goal');
  });
  it('rejects unknown initialization purposes', async () => {
    expect((await build('arbitrary-purpose')).status).toBe(400);
  });
});
