import { jsonSchema, tool, type ToolCallRepairFunction, type ToolSet } from 'ai';
import type { RegisteredTool } from './contracts.js';
import { INVALID_TOOL_ID } from './tool-invalid.js';

type LoopToolDefinition = Omit<RegisteredTool, 'execute'>;

export interface LoopToolSet {
  tools: ToolSet;
  activeTools: string[];
  resolveToolId: (modelToolName: string) => string | null;
  resolveModelToolName: (toolId: string) => string | null;
  repairToolCall: ToolCallRepairFunction<ToolSet>;
}

const genericInputSchema = jsonSchema<Record<string, unknown>>({
  type: 'object',
  additionalProperties: true,
});

export function buildLoopToolSet(definitions: LoopToolDefinition[]): LoopToolSet {
  const tools: ToolSet = {};
  const usedNames = new Set<string>();
  const modelToRuntime = new Map<string, string>();
  const runtimeToModel = new Map<string, string>();

  for (const definition of definitions.toSorted((a, b) => a.id.localeCompare(b.id))) {
    const modelName = uniqueToolName(toModelToolName(definition.id), usedNames);
    usedNames.add(modelName);
    modelToRuntime.set(modelName, definition.id);
    modelToRuntime.set(definition.id, definition.id);
    runtimeToModel.set(definition.id, modelName);
    tools[modelName] = tool({
      title: definition.label,
      description: [definition.description, definition.progressiveDetails].filter(Boolean).join(' '),
      inputSchema: definition.inputSchema ?? genericInputSchema,
      metadata: {
        runtimeToolId: definition.id,
        category: definition.category,
        mutability: definition.mutability,
      },
    });
  }

  const resolveToolId = (modelToolName: string): string | null => modelToRuntime.get(modelToolName) ?? null;
  const resolveModelToolName = (toolId: string): string | null => runtimeToModel.get(toolId) ?? null;

  return {
    tools,
    activeTools: [...usedNames],
    resolveToolId,
    resolveModelToolName,
    repairToolCall: async (failed) => {
      const direct = resolveModelToolName(resolveToolId(failed.toolCall.toolName) ?? failed.toolCall.toolName);
      if (direct) return { ...failed.toolCall, toolName: direct };

      let normalized = failed.toolCall.toolName.toLowerCase();
      if (normalized.startsWith('functions.')) {
        normalized = normalized.slice('functions.'.length);
      }
      const match = [...runtimeToModel.entries()].find(([toolId, modelName]) => {
        return toolId.toLowerCase() === normalized || modelName.toLowerCase() === normalized;
      });
      if (match) return { ...failed.toolCall, toolName: match[1] };

      // Redirect unrecognized tool calls to the invalid tool for self-healing feedback
      const invalidModelName = runtimeToModel.get(INVALID_TOOL_ID);
      if (invalidModelName) {
        return {
          ...failed.toolCall,
          input: JSON.stringify({ tool: failed.toolCall.toolName, error: failed.error.message }),
          toolName: invalidModelName,
        };
      }
      return null;
    },
  };
}

function toModelToolName(toolId: string): string {
  const sanitized = toolId.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  return sanitized || 'tool';
}

function uniqueToolName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) return baseName;
  let index = 2;
  while (usedNames.has(`${baseName}_${index}`)) index += 1;
  return `${baseName}_${index}`;
}
