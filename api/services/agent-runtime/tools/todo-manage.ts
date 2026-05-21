import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { agentEventService } from '../event-service.js';
import { agentRuntimeStore } from '../session-store.js';

interface TodoItem {
  id: string;
  label: string;
  status: 'pending' | 'in_progress' | 'done';
}

const DRIFT_THRESHOLD = 3;

function getLatestTodos(sessionId: string): TodoItem[] {
  const events = agentRuntimeStore.listEvents(sessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'todo_updated') {
      return (events[i].payload.items as TodoItem[]) ?? [];
    }
  }
  return [];
}

export function buildTodoDriftReminder(sessionId: string): string | null {
  const events = agentRuntimeStore.listEvents(sessionId);
  let lastTodoIndex = -1;
  let hasTodos = false;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'todo_updated') {
      lastTodoIndex = i;
      hasTodos = true;
      break;
    }
  }
  if (!hasTodos) return null;

  const stepsSince = events
    .slice(lastTodoIndex + 1)
    .filter(e => e.type === 'tool_result').length;

  if (stepsSince < DRIFT_THRESHOLD) return null;

  const items = getLatestTodos(sessionId);
  const pending = items.filter(i => i.status === 'pending').length;
  const inProgress = items.filter(i => i.status === 'in_progress').length;
  if (pending === 0 && inProgress === 0) return null;

  return `Your TODO list has not been updated for ${stepsSince} steps. Review your progress and update it using todo.manage. Current: ${inProgress} in_progress, ${pending} pending.`;
}

export const todoManageTool: RegisteredTool = {
  id: 'todo.manage',
  label: 'Manage TODO',
  description:
    'Create or update a TODO list for the current session to track task progress. Use "set" to replace the full list, "update" to change a single item status.',
  category: 'task',
  internalGate: 'none',
  mutability: 'write',
  resumeBehavior: 'auto',
  progressiveDetails:
    'Accepts { action: "set"|"update", items?: [{id, label, status}], itemId?, status? }. Status: pending|in_progress|done.',
  inputSchema: z.object({
    action: z.enum(['set', 'update']).describe('"set" replaces the full list, "update" changes one item.'),
    items: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      status: z.enum(['pending', 'in_progress', 'done']),
    })).optional().describe('Full TODO list (required for "set" action).'),
    itemId: z.string().optional().describe('Item ID to update (required for "update" action).'),
    status: z.enum(['pending', 'in_progress', 'done']).optional().describe('New status (required for "update" action).'),
  }),
  execute(input) {
    const args = input.args as {
      action: 'set' | 'update';
      items?: TodoItem[];
      itemId?: string;
      status?: 'pending' | 'in_progress' | 'done';
    };

    let items: TodoItem[];

    if (args.action === 'set') {
      if (!args.items || args.items.length === 0) {
        throw new Error('items is required for "set" action.');
      }
      items = args.items;
    } else {
      if (!args.itemId || !args.status) {
        throw new Error('itemId and status are required for "update" action.');
      }
      items = getLatestTodos(input.sessionId);
      const target = items.find(i => i.id === args.itemId);
      if (!target) {
        throw new Error(`TODO item "${args.itemId}" not found.`);
      }
      target.status = args.status;
    }

    const inProgressCount = items.filter(i => i.status === 'in_progress').length;
    if (inProgressCount > 1) {
      throw new Error(`Only one item can be in_progress at a time (found ${inProgressCount}). Focus on one task before starting another.`);
    }

    agentEventService.append({
      sessionId: input.sessionId,
      type: 'todo_updated',
      summary: `TODO list updated (${items.filter(i => i.status === 'done').length}/${items.length} done).`,
      payload: { items },
    });

    const done = items.filter(i => i.status === 'done').length;
    return {
      result: { items, progress: `${done}/${items.length}` },
      displaySummary: `TODO: ${done}/${items.length} completed.`,
      artifacts: [],
    };
  },
};
