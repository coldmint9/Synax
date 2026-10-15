import { beforeEach, describe, expect, it } from 'vitest';
import { taskCreateTool, taskUpdateTool, taskListTool, TaskStore } from '../tools/task-tools.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { workStore } from '../work-store.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

beforeEach(() => { resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered(); });

describe('task tools', () => {
  it('marks task mutations with task mutability', () => {
    expect(taskCreateTool.mutability).toBe('task');
    expect(taskUpdateTool.mutability).toBe('task');
    expect(taskListTool.mutability).toBe('read');
  });

  it('keeps the session TODO list after a later run attaches new work', () => {
    const s = agentSessionRuntime.create({
      projectId: 'project-alpha', profileId: 'synax', prompt: 'Track work',
      sessionMetadata: { mode: 'chat' },
    });
    workStore.create(s.id, 'first objective');
    const created = new TaskStore();
    const task = created.create('Tracked work', 'pending');
    created.persist(s.id);
    expect(TaskStore.fromEvents(s.id).list().map(t => `${t.id}:${t.status}`))
      .toEqual([`${task.id}:pending`]);

    // A new run attaches its own work; the TODO list is session-scoped and must
    // stay readable, otherwise task.update cannot find its own task.
    workStore.create(s.id, 'second objective');
    const resumed = TaskStore.fromEvents(s.id);
    expect(resumed.list().map(t => t.id)).toEqual([task.id]);
    expect(() => resumed.update(task.id, { status: 'completed' })).not.toThrow();
    resumed.persist(s.id);
    expect(TaskStore.fromEvents(s.id).list()[0].status).toBe('completed');
  });
});
