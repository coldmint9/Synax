import { beforeEach, describe, expect, it } from 'vitest';
import { agentRuntimeRoutes } from '../../../routes/agent-runtime.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('agent runtime route contracts', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('lists profiles and creates role-specific sessions', async () => {
    const profiles = await agentRuntimeRoutes.request('http://local/profiles');
    expect(profiles.status).toBe(200);
    expect((await profiles.json()).items.map((profile: { id: string }) => profile.id)).toContain('planner');

    const created = await agentRuntimeRoutes.request('http://local/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-alpha',
        profileId: 'planner',
        prompt: 'Plan the feature',
      }),
    });

    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.session.profileId).toBe('planner');
    expect(body.context.id).toMatch(/^acb_/);
  });

  it('builds project context and exposes events/runs/artifacts routes', async () => {
    const context = await agentRuntimeRoutes.request('http://local/contexts/project-alpha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-1', profileId: 'explorer' }),
    });
    expect(context.status).toBe(201);

    const created = await agentRuntimeRoutes.request('http://local/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-alpha',
        profileId: 'explorer',
        prompt: 'Explore',
      }),
    });
    const body = await created.json();
    const sessionId = body.session.id;

    const events = await agentRuntimeRoutes.request(`http://local/sessions/${sessionId}/events`);
    const runs = await agentRuntimeRoutes.request(`http://local/sessions/${sessionId}/runs`);
    const artifacts = await agentRuntimeRoutes.request(`http://local/sessions/${sessionId}/artifacts`);

    expect(events.status).toBe(200);
    expect(runs.status).toBe(200);
    expect(artifacts.status).toBe(200);
  });
});
