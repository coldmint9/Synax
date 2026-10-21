import type { ToolSet } from "../../infrastructure/llm-runtime/contracts.js";
import { jsonSchema } from "../../infrastructure/llm-runtime/tool-schema.js";
import { asSchema } from "../../infrastructure/llm-runtime/tool-schema.js";
import { createHash } from 'node:crypto';
import type { RegisteredTool } from './contracts.js';

type LoopToolDefinition = Omit<RegisteredTool, 'execute'>;

export interface LoopToolSet {
  tools: ToolSet;
  activeTools: string[];
  resolveToolId: (modelToolName: string) => string | null;
  resolveModelToolName: (toolId: string) => string | null;
  resolveHistoricalModelToolName?: (toolId: string) => string;
}

const genericInputSchema = jsonSchema<Record<string, unknown>>({
  type: 'object',
  additionalProperties: true,
});

// asSchema creates a new lazy Zod adapter on every call. Reuse that adapter so
// accounting, fingerprints and provider dispatch share one JSON conversion,
// including across steps. Weak keys release schemas when tools are replaced.
const inputSchemas = new WeakMap<NonNullable<LoopToolDefinition['inputSchema']>, ReturnType<typeof asSchema>>();
function modelInputSchema(schema: LoopToolDefinition['inputSchema']) {
  if (!schema) return genericInputSchema;
  let adapted = inputSchemas.get(schema);
  if (!adapted) {
    adapted = asSchema(schema);
    inputSchemas.set(schema, adapted);
  }
  return adapted;
}

export function buildLoopToolSet(
  definitions: LoopToolDefinition[],
  activeDefinitions?: LoopToolDefinition[],
  options: { stableNames?: boolean } = {},
): LoopToolSet {
  const tools: ToolSet = {};
  const usedNames = new Set<string>();
  const modelToRuntime = new Map<string, string>();
  const runtimeToModel = new Map<string, string>();

  for (const definition of definitions.toSorted((a, b) => a.id.localeCompare(b.id))) {
    const modelName = uniqueToolName(toModelToolName(definition.id, options.stableNames === true), usedNames);
    usedNames.add(modelName);
    modelToRuntime.set(modelName, definition.id);
    modelToRuntime.set(definition.id, definition.id);
    runtimeToModel.set(definition.id, modelName);
    tools[modelName] = {
      title: definition.label,
      description: [definition.description, definition.progressiveDetails].filter(Boolean).join(' '),
      inputSchema: modelInputSchema(definition.inputSchema),
      metadata: {
        runtimeToolId: definition.id,
        category: definition.category,
        mutability: definition.mutability,
      },
    };
  }

  const activeToolNames = activeDefinitions
    ? activeDefinitions.map((d) => runtimeToModel.get(d.id)).filter((n): n is string => Boolean(n))
    : [...usedNames];

  const resolveToolId = (modelToolName: string): string | null => modelToRuntime.get(modelToolName) ?? null;
  const resolveModelToolName = (toolId: string): string | null => runtimeToModel.get(toolId) ?? null;

  return {
    tools,
    activeTools: activeToolNames,
    resolveToolId,
    resolveModelToolName,
    resolveHistoricalModelToolName: (id) => toModelToolName(id, options.stableNames === true),

  };
}

export function toModelToolName(toolId: string, stable = true): string {
  const sanitized = toolId.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  if (!stable) return sanitized || 'tool';
  // Ordinary dotted IDs keep their historical names. Unusual IDs carry a
  // stable suffix so adding/removing a colliding tool cannot rename a call.
  if (/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/.test(toolId) && sanitized.length <= 64)
    return sanitized;
  return `synax__${(sanitized || 'tool').slice(0, 40)}_${createHash('sha256').update(toolId).digest('hex').slice(0, 16)}`;
}

function uniqueToolName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) return baseName;
  let index = 2;
  while (usedNames.has(`${baseName}_${index}`)) index += 1;
  return `${baseName}_${index}`;
}
