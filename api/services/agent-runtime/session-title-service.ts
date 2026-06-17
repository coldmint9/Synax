import { logger } from '../../lib/logger.js';
import { generateGatewayTextResult } from '../llm-runtime/gateway.js';
import { resolveGoalTitleSource } from '../wiki/wiki-goal-title.js';
import { sessionHooks } from './session-hooks.js';
import { agentRuntimeStore } from './session-store.js';
import { nowIso } from './runtime-ids.js';

const INITIAL_TITLE_MAX_LEN = 80;
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'waiting_permission',
  'blocked',
  'cancelled',
  'interrupted',
]);

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

function looksLikeSystemPrompt(prompt: string): boolean {
  return prompt.includes('## ') || /^You are\b/m.test(prompt);
}

function truncateInitialTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= INITIAL_TITLE_MAX_LEN) return trimmed;
  return `${trimmed.slice(0, INITIAL_TITLE_MAX_LEN - 1)}…`;
}

export function resolveInitialSessionTitle(input: {
  sessionMetadata: Record<string, unknown> | null;
  prompt: string;
}): string | null {
  const fromGoal = resolveGoalTitleSource(input);
  if (fromGoal) return truncateInitialTitle(fromGoal);

  const prompt = input.prompt.trim();
  if (!prompt) return null;
  if (prompt.length <= 120 && !looksLikeSystemPrompt(prompt)) {
    return truncateInitialTitle(prompt);
  }
  return null;
}

let titleHooksRegistered = false;

export function registerSessionTitleHooks(): void {
  if (titleHooksRegistered) return;
  titleHooksRegistered = true;

  sessionHooks.register({
    id: 'session-title-after-first-run',
    filter: { eventTypes: ['run:completed'] },
    handler: (event) => {
      if (event.type !== 'run:completed') return;
      void summarizeTitleAfterFirstRun(event.sessionId, event.runId);
    },
  });
}

async function summarizeTitleAfterFirstRun(sessionId: string, runId: string): Promise<void> {
  const session = agentRuntimeStore.tryGetSession(sessionId);
  if (!session) return;
  if (session.sessionMetadata?.titleSummarized === true) return;

  const runs = agentRuntimeStore.listRuns(sessionId);
  const terminalRuns = runs.filter((run) => TERMINAL_RUN_STATUSES.has(run.status));
  if (terminalRuns.length !== 1 || terminalRuns[0]?.id !== runId) return;

  agentRuntimeStore.updateSessionMetadata(sessionId, { titleSummarized: true });
  generateSessionTitle(sessionId, session.projectId, session.profileId, session.prompt);
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
