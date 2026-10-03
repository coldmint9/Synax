import { describe, expect, it } from 'vitest';
import { taskCreateTool, taskUpdateTool, taskListTool } from '../tools/task-tools.js';

describe('task tools', () => {
  it('marks task mutations with task mutability', () => {
    expect(taskCreateTool.mutability).toBe('task');
    expect(taskUpdateTool.mutability).toBe('task');
    expect(taskListTool.mutability).toBe('read');
  });
});
