import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_STRATEGY,
  createState,
  filterByDisclosure,
} from '../tool-disclosure.js';
import { taskCreateTool, taskUpdateTool, taskListTool } from '../tools/task-tools.js';

describe('task tool disclosure', () => {
  it('exposes task.create and task.update in the explore tier', () => {
    const tools = [taskCreateTool, taskUpdateTool, taskListTool];
    const visible = filterByDisclosure(tools, createState(), EXECUTOR_STRATEGY);
    expect(visible.map((tool) => tool.id)).toEqual(
      expect.arrayContaining(['task.create', 'task.update', 'task.list']),
    );
  });

  it('marks task mutations with task mutability', () => {
    expect(taskCreateTool.mutability).toBe('task');
    expect(taskUpdateTool.mutability).toBe('task');
  });
});
