import { logger } from '../../lib/logger.js';
import { generateGatewayTextResult } from '../llm-runtime/gateway.js';
import { agentRuntimeStore } from './session-store.js';
import { nowIso } from './runtime-ids.js';

export interface TitleGeneratorContext {
  sessionId: string;
  projectId: string;
  profileId: string;
  prompt: string;
}

export interface TitleGenerator {
  generate(ctx: TitleGeneratorContext): string | Promise<string | null> | null;
}

const registry = new Map<string, TitleGenerator>();

export function registerTitleGenerator(profileId: string, generator: TitleGenerator): void {
  registry.set(profileId, generator);
}

export function unregisterTitleGenerator(profileId: string): void {
  registry.delete(profileId);
}

export function generateSessionTitle(
  sessionId: string,
  projectId: string,
  profileId: string,
  prompt: string,
): void {
  const ctx: TitleGeneratorContext = { sessionId, projectId, profileId, prompt };
  const custom = registry.get(profileId);

  if (custom) {
    const result = custom.generate(ctx);
    if (typeof result === 'string') {
      agentRuntimeStore.updateSession(sessionId, { title: result, updatedAt: nowIso() });
      return;
    }
    if (result && typeof (result as Promise<string | null>).then === 'function') {
      void (result as Promise<string | null>).then((title) => {
        if (title) agentRuntimeStore.updateSession(sessionId, { title, updatedAt: nowIso() });
      }).catch((err) => {
        logger.debug({ sessionId, err }, '[session-title] custom generator failed');
      });
      return;
    }
  }

  void generateTitleWithLlm(ctx).catch((err) => {
    logger.debug({ sessionId, err }, '[session-title] LLM title generation failed silently');
  });
}

async function generateTitleWithLlm(ctx: TitleGeneratorContext): Promise<void> {
  const truncated = ctx.prompt.slice(0, 200);
  const result = await generateGatewayTextResult({
    projectId: ctx.projectId,
    purpose: 'session-title',
    messages: [
      {
        role: 'user',
        content: `Generate a short title (max 10 Chinese characters or 6 English words) for this task. Return ONLY the title, no quotes or punctuation.\n\nTask: ${truncated}`,
      },
    ],
    maxTokens: 30,
    temperature: 0.3,
  });

  const title = (result.text ?? '').trim().slice(0, 50);
  if (title) {
    agentRuntimeStore.updateSession(ctx.sessionId, { title, updatedAt: nowIso() });
  }
}
