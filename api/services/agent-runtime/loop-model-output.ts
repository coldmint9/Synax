import type { LoopModelStep } from './contracts.js';
import { makeRuntimeId } from './runtime-ids.js';

export function parseLoopModelStepText(text: string, mustFinalize: boolean): LoopModelStep {
  const normalized = text.trim();
  if (!mustFinalize) {
    const shorthand = parseLeadingToolJson(normalized);
    if (shorthand) {
      return {
        thought: undefined,
        message: shorthand.message,
        toolCalls: [{ id: makeRuntimeId('mtc'), toolId: shorthand.toolId, args: shorthand.args }],
        final: false,
        stopReason: null,
        finishReason: 'tool_text_fallback',
      };
    }
  }

  return {
    thought: undefined,
    message: normalized || undefined,
    toolCalls: [],
    final: true,
    stopReason: mustFinalize ? 'max_steps' : null,
    finishReason: mustFinalize ? 'max_steps' : 'text',
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseLeadingToolJson(text: string): { toolId: string; args: Record<string, unknown>; message?: string } | null {
  if (!text.startsWith('{')) return null;
  const extracted = extractLeadingJsonObject(text);
  if (!extracted || !isRecord(extracted.value)) return null;
  const toolId = typeof extracted.value.toolId === 'string'
    ? extracted.value.toolId
    : typeof extracted.value.tool === 'string'
      ? extracted.value.tool
      : null;
  if (!toolId) return null;
  const args = isRecord(extracted.value.args) ? extracted.value.args : {};
  const message = trailingText(extracted.trailingText) ?? objectMessage(extracted.value);
  return { toolId, args, message };
}

function extractLeadingJsonObject(text: string): { value: unknown; trailingText: string } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return {
            value: JSON.parse(text.slice(0, index + 1)),
            trailingText: text.slice(index + 1).trim(),
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function objectMessage(value: Record<string, unknown>): string | undefined {
  for (const key of ['message', 'summary', 'text']) {
    const child = value[key];
    if (typeof child === 'string' && child.trim()) return child.trim();
  }
  return undefined;
}

function trailingText(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed || undefined;
}
