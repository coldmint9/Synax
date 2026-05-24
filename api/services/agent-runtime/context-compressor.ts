import type { CompactionConfig, CompactionRecord } from './contracts.js';
import { countMessagesTokens, countTokens } from './context-tokenizer.js';
import type { LlmGatewayMessage } from '../llm-runtime/types.js';
import { makeRuntimeId } from './runtime-ids.js';
import { logger } from '../../lib/logger.js';

type ModelMessage = { role: string; content: unknown };

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  threshold: 0.75,
  preserveRecentMessages: 4,
  maxSummaryTokens: 2000,
};

const COMPACTION_SYSTEM_PROMPT = `You are a conversation compressor. Summarize the following conversation history into a concise summary that preserves:
1. The user's original goal and intent
2. Key actions taken and their outcomes
3. Important discoveries, file paths, variable names, and technical details
4. Current state and what remains to be done

Rules:
- Keep specific identifiers (file paths, function names, error messages) verbatim
- Omit redundant tool call details — summarize outcomes only
- Target 15-25% of original length
- Use bullet points for clarity
- Write in the same language as the original conversation`;

export interface CompactionContext {
  sessionId: string;
  runId: string | null;
  model?: string;
  contextLimit: number;
  config?: Partial<CompactionConfig>;
  generateSummary: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

export interface CompactionResult {
  messages: ModelMessage[];
  record: CompactionRecord | null;
  didCompact: boolean;
}

export function getCompactionConfig(
  overrides?: Partial<CompactionConfig>,
): CompactionConfig {
  return { ...DEFAULT_COMPACTION_CONFIG, ...overrides };
}

export function shouldCompact(
  totalTokens: number,
  contextLimit: number,
  config: CompactionConfig,
): boolean {
  if (!config.enabled) return false;
  return totalTokens > contextLimit * config.threshold;
}

export async function compactMessages(
  messages: ModelMessage[],
  ctx: CompactionContext,
): Promise<CompactionResult> {
  const config = getCompactionConfig(ctx.config);

  if (!config.enabled || messages.length <= config.preserveRecentMessages) {
    return { messages, record: null, didCompact: false };
  }

  const splitIndex = Math.max(
    messages.length - config.preserveRecentMessages,
    1,
  );
  const compressible = messages.slice(0, splitIndex);
  const preserved = messages.slice(splitIndex);

  const originalTokens = countMessagesTokens(
    compressible as unknown as import('../llm-runtime/types.js').LlmGatewayMessage[],
    ctx.model,
  );

  const conversationText = serializeMessagesForSummary(compressible);

  logger.info(
    {
      sessionId: ctx.sessionId,
      compressibleCount: compressible.length,
      preservedCount: preserved.length,
      originalTokens,
    },
    '[context-compressor] compacting conversation history',
  );

  let summaryText: string;
  try {
    summaryText = await ctx.generateSummary(
      COMPACTION_SYSTEM_PROMPT,
      `Summarize this conversation:\n\n${conversationText}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, '[context-compressor] summary generation failed, skipping compaction');
    return { messages, record: null, didCompact: false };
  }

  const compressedTokens = countTokens(summaryText, ctx.model);

  const summaryMessage: ModelMessage = {
    role: 'user',
    content: `<context-summary>\n[Previous conversation summary - compressed to save context]\n${summaryText}\n</context-summary>\n\n<system-note>Context was compressed. Before continuing, briefly confirm: (1) what you have accomplished so far, (2) what remains to be done. Then proceed with the next action.</system-note>`,
  };

  const compactedMessages: ModelMessage[] = [summaryMessage, ...preserved];

  const record: CompactionRecord = {
    id: makeRuntimeId('cmp'),
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    summaryText,
    compressedMessageCount: compressible.length,
    originalTokenCount: originalTokens,
    compressedTokenCount: compressedTokens,
    createdAt: new Date().toISOString(),
  };

  logger.info(
    {
      sessionId: ctx.sessionId,
      originalTokens,
      compressedTokens,
      ratio: ((compressedTokens / originalTokens) * 100).toFixed(1) + '%',
    },
    '[context-compressor] compaction complete',
  );

  return { messages: compactedMessages, record, didCompact: true };
}

function serializeMessagesForSummary(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const role = message.role.toUpperCase();
    const content = message.content;

    if (typeof content === 'string') {
      lines.push(`[${role}]: ${content}`);
      continue;
    }
    if (!Array.isArray(content)) continue;

    const parts: string[] = [];
    for (const part of content) {
      if ('text' in part && typeof part.text === 'string') {
        parts.push(part.text);
      } else if (part.type === 'tool-call') {
        const tc = part as { toolName?: string; input?: unknown };
        parts.push(`[Tool: ${tc.toolName ?? 'unknown'}(${JSON.stringify(tc.input ?? {}).slice(0, 200)})]`);
      } else if (part.type === 'tool-result') {
        const tr = part as { toolName?: string; output?: { value?: unknown } };
        const val = tr.output?.value ? String(tr.output.value).slice(0, 500) : '';
        parts.push(`[Result: ${tr.toolName ?? 'tool'} → ${val}]`);
      }
    }
    if (parts.length > 0) {
      lines.push(`[${role}]: ${parts.join('\n')}`);
    }
  }
  return lines.join('\n\n');
}

