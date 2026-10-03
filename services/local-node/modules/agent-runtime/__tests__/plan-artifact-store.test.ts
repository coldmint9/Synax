import { beforeEach, describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore as store } from '../session-store.js';
import {
  createPlanArtifact,
  getPlanArtifact,
  listPlanArtifacts,
  restorePlanArtifact,
} from '../plan-artifact-store.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';

const plan = (title: string) => ({
  title,
  objective: 'Deliver a verified change',
  steps: [{ id: 'step-1', title: 'Inspect', description: 'Inspect the code', dependsOn: [], expectedFiles: [] }],
  acceptanceCriteria: ['Tests pass'],
  humanAcceptanceCriteria: [],
  assumptions: [],
  risks: [],
});

beforeEach(() => { resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered(); });

describe('plan artifact store', () => {
  it('persists immutable revisions and restores an older revision as a new draft', () => {
    const session = agentSessionRuntime.create({
      projectId: 'project-alpha',
      profileId: 'synax',
      prompt: 'Deliver a verified change',
      sessionMetadata: { mode: 'chat' },
    });

    const first = createPlanArtifact({ sessionId: session.id, plan: plan('First') });
    const second = createPlanArtifact({ sessionId: session.id, plan: plan('Second') });
    const restored = restorePlanArtifact(session.id, first.revision);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(restored.revision).toBe(3);
    expect(restored.status).toBe('draft');
    expect(restored.title).toBe('First');
    expect(listPlanArtifacts(session.id).map((item) => item.revision)).toEqual([3, 2, 1]);
    expect(getPlanArtifact(session.id, 1)?.title).toBe('First');
  });

  it('reads the current legacy metadata plan until it is replaced by an artifact', () => {
    const session = agentSessionRuntime.create({
      projectId: 'project-alpha',
      profileId: 'synax',
      prompt: 'Legacy plan',
      sessionMetadata: { mode: 'chat' },
    });
    store.updateSessionMetadata(session.id, {
      plan: { ...plan('Legacy'), revision: 4, status: 'saved' },
    });

    expect(getPlanArtifact(session.id)?.revision).toBe(4);
    expect(listPlanArtifacts(session.id)[0]?.title).toBe('Legacy');
  });
});
