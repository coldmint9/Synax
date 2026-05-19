import * as z from 'zod/v4';
import type { RegisteredTool } from './contracts.js';

export const INVALID_TOOL_ID = 'tools.invalid';

export const INVALID_TOOL: RegisteredTool = {
  id: INVALID_TOOL_ID,
  label: 'Invalid Tool',
  description: 'Do not use this tool.',
  category: 'context',
  mutability: 'read',
  resumeBehavior: 'auto',
  progressiveDetails:
    'Fallback tool returned when a model requests an unavailable tool. Use the currently disclosed tool names instead.',
  inputSchema: z.object({
    tool: z.string().describe('The tool name that was attempted.'),
    error: z.string().describe('The error message.'),
  }),
  execute: (input) => {
    const args = input.args as { tool?: string; error?: string };
    return {
      result: { error: true },
      displaySummary: `Invalid tool call: ${args.tool ?? 'unknown'}. ${args.error ?? 'Tool not found.'}`,
      artifacts: [],
      followUpHints: ['Use only the tools listed in the current tool set. Check the tool name and try again.'],
    };
  },
};
