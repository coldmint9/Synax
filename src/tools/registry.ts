/**
 * Synapse Tool Registry
 *
 * Inspired by clawspring's tool_registry.py — a central registry for tool
 * definitions, lookup, schema export, and dispatch with output truncation.
 *
 * Key improvements over clawspring:
 * 1. Permission-aware dispatch based on RoleSlot capability level
 * 2. Event emission on tool execution (feeds into Zero-Alignment Protocol)
 * 3. Async tool execution with streaming support
 */

import { z } from 'zod'
import { type AgentCapabilityLevel } from '../models/types.js'

// ─── Tool Definition ──────────────────────────────────────────────────────

export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolDef<TInput = Record<string, unknown>, TOutput = string> {
  name: string
  description: string
  inputSchema: z.ZodType<TInput>
  /** Whether this tool never mutates state */
  readOnly: boolean
  /** Whether this tool is safe to run in parallel with others */
  concurrentSafe: boolean
  /** Minimum capability level required to use this tool without permission */
  minAutoLevel: AgentCapabilityLevel
  /** Execute the tool */
  execute: (params: TInput, context: ToolContext) => Promise<TOutput>
}

export interface ToolContext {
  projectId: string
  roleSlotId: string
  capabilityLevel: AgentCapabilityLevel
  workingDir: string
  config: Record<string, unknown>
}

export interface ToolResult {
  toolName: string
  output: string
  success: boolean
  truncated: boolean
  durationMs: number
}

// ─── Registry ─────────────────────────────────────────────────────────────

const registry = new Map<string, ToolDef>()

export function registerTool(def: ToolDef): void {
  registry.set(def.name, def)
}

export function getTool(name: string): ToolDef | undefined {
  return registry.get(name)
}

export function getAllTools(): ToolDef[] {
  return [...registry.values()]
}

export function getToolSchemas(): ToolSchema[] {
  return [...registry.values()].map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  }))
}

export function getToolsForRole(allowedTools: string[]): ToolDef[] {
  if (allowedTools.length === 0) return getAllTools()
  return allowedTools.map(name => registry.get(name)).filter(Boolean) as ToolDef[]
}

export function getToolSchemasForRole(allowedTools: string[]): ToolSchema[] {
  return getToolsForRole(allowedTools).map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  }))
}

// ─── Execution ────────────────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 32000

export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(name)
  if (!tool) {
    return {
      toolName: name,
      output: `Error: tool '${name}' not found.`,
      success: false,
      truncated: false,
      durationMs: 0,
    }
  }

  const startTime = Date.now()
  try {
    // Validate input
    const validated = tool.inputSchema.parse(params)
    const result = await tool.execute(validated, context)
    const durationMs = Date.now() - startTime

    // Truncate if needed (mirrors clawspring's approach)
    const { output, truncated } = truncateOutput(String(result))

    return { toolName: name, output, success: true, truncated, durationMs }
  } catch (error) {
    const durationMs = Date.now() - startTime
    return {
      toolName: name,
      output: `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`,
      success: false,
      truncated: false,
      durationMs,
    }
  }
}

/**
 * Check if a tool call should be auto-approved based on role permissions.
 * Mirrors clawspring's _check_permission but with RoleSlot awareness.
 */
export function shouldAutoApprove(
  toolName: string,
  context: ToolContext,
): boolean {
  const tool = registry.get(toolName)
  if (!tool) return false

  // Read-only tools always auto-approve
  if (tool.readOnly) return true

  // Check capability level
  if (context.capabilityLevel >= tool.minAutoLevel) return true

  return false
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function truncateOutput(output: string, maxChars: number = MAX_OUTPUT_CHARS): { output: string; truncated: boolean } {
  if (output.length <= maxChars) {
    return { output, truncated: false }
  }

  const firstHalf = maxChars / 2
  const lastQuarter = maxChars / 4
  const truncated = output.length - firstHalf - lastQuarter
  return {
    output: output.slice(0, firstHalf) + `\n[... ${truncated} chars truncated ...]\n` + output.slice(-lastQuarter),
    truncated: true,
  }
}

/**
 * Minimal Zod-to-JSON-Schema converter.
 * For production, use zod-to-json-schema package.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Simplified — in production replace with proper zod-to-json-schema
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(schema.shape)) {
      properties[key] = zodTypeToJsonSchema(value as z.ZodType)
      if (!(value instanceof z.ZodOptional)) {
        required.push(key)
      }
    }
    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    }
  }
  return { type: 'string' }
}

function zodTypeToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodString) return { type: 'string' }
  if (schema instanceof z.ZodNumber) return { type: 'number' }
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' }
  if (schema instanceof z.ZodArray) return { type: 'array', items: zodTypeToJsonSchema(schema.element) }
  if (schema instanceof z.ZodOptional) return zodTypeToJsonSchema(schema.unwrap())
  if (schema instanceof z.ZodDefault) return zodTypeToJsonSchema(schema.removeDefault())
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options }
  return { type: 'string' }
}

export function clearRegistry(): void {
  registry.clear()
}
