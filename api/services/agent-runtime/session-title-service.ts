import { outsideExecutionContext } from '../../lib/execution-context.js';
import { startAuxUsage, finishAuxUsage } from './usage-projection.js';
import { logger } from '../../lib/logger.js';
import { sessionHooks } from './session-hooks.js';
import { generateGatewayTextResult } from '../llm-runtime/gateway.js';
import { resolveGoalTitleSource } from '../wiki/wiki-goal-title.js';
import type { AgentRunStreamChunk, AgentSession } from './contracts.js';
import { agentRuntimeStore } from './session-store.js';
import { nowIso } from './runtime-ids.js';

function resolveUserTitleInput(sessionId: string, sessionPrompt: string): string {
  const session = agentRuntimeStore.tryGetSession(sessionId);
  return resolveGoalTitleSource({
    sessionMetadata: session?.sessionMetadata ?? null,
    prompt: sessionPrompt,
  }) ?? sessionPrompt.trim();
}

const INITIAL_TITLE_MAX_LEN = 80;
export const DEFAULT_NEW_AGENT_SESSION_TITLE = 'new agent';

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
const titleGenerationInFlight = new Map<string, Promise<void>>();
const titleGenerationQueued = new Set<string>();

/**
 * Schedule session-title generation off the caller's critical path.
 *
 * The work is (a) coalesced per session so duplicated triggers during one
 * turn never fan out into several LLM calls, and (b) deferred to the next
 * macrotask so it can never run inside stream teardown / IPC message
 * handling. Title generation must stay truly asynchronous: it must not delay
 * the turn stream, and the run's own model calls must not wait behind it.
 */
function scheduleSessionTitleGeneration(
  sessionId: string,
  runId: string | undefined,
  trigger: 'run_started' | 'stream_done',
): void {
  if (titleGenerationInFlight.has(sessionId)) {
    // A generation is already running; re-check once it settles so a title
    // is still produced if that attempt failed to persist one.
    titleGenerationQueued.add(sessionId);
    return;
  }
  const task = outsideExecutionContext(() => runDeferredSessionTitleGeneration(sessionId, runId, trigger));
  titleGenerationInFlight.set(sessionId, task);
  void task.finally(() => {
    titleGenerationInFlight.delete(sessionId);
    if (titleGenerationQueued.delete(sessionId)) {
      scheduleSessionTitleGeneration(sessionId, undefined, 'stream_done');
    }
  });
}

async function runDeferredSessionTitleGeneration(
  sessionId: string,
  runId: string | undefined,
  trigger: 'run_started' | 'stream_done',
): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await runSessionTitleGeneration(sessionId, runId, trigger);
}

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

function fallbackTitleFromUserInput(userInput: string): string | null {
  const trimmed = userInput.trim();
  if (!trimmed || trimmed === DEFAULT_NEW_AGENT_SESSION_TITLE) return null;
  if (looksLikeSystemPrompt(trimmed)) return null;
  return truncateInitialTitle(trimmed);
}

const MAX_GENERATED_CJK_CHARS = 10;
const MAX_GENERATED_ENGLISH_WORDS = 6;
const MAX_GENERATED_TITLE_LEN = 50;

function countCjkChars(text: string): number {
  return [...text].filter((ch) => /\p{Script=Han}/u.test(ch)).length;
}

function countEnglishWords(text: string): number {
  const latin = text.replace(/\p{Script=Han}/gu, ' ').trim();
  if (!latin) return 0;
  return latin.split(/\s+/).filter(Boolean).length;
}

/** Validate LLM-generated titles against prompt constraints. */
export function isValidGeneratedSessionTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > MAX_GENERATED_TITLE_LEN) return false;
  if (trimmed === DEFAULT_NEW_AGENT_SESSION_TITLE) return false;
  if (/[\n\r]/.test(trimmed)) return false;
  if (looksLikeSystemPrompt(trimmed)) return false;
  if (/^["'`「『【〈《[]/.test(trimmed) && /["'`」』】〉》\])]$/.test(trimmed)) return false;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return false;

  const cjkCount = countCjkChars(trimmed);
  const wordCount = countEnglishWords(trimmed);
  if (cjkCount > 0 && wordCount === 0) return cjkCount <= MAX_GENERATED_CJK_CHARS;
  if (wordCount > 0 && cjkCount === 0) return wordCount >= 1 && wordCount <= MAX_GENERATED_ENGLISH_WORDS;
  return cjkCount <= MAX_GENERATED_CJK_CHARS && wordCount <= MAX_GENERATED_ENGLISH_WORDS;
}

function resolveFinalSessionTitle(
  llmTitle: string | null,
  userInput: string,
): { title: string; usedFallback: boolean } | null {
  const normalized = llmTitle?.trim();
  if (normalized && isValidGeneratedSessionTitle(normalized)) {
    return { title: normalized, usedFallback: false };
  }
  const fallback = fallbackTitleFromUserInput(userInput);
  if (!fallback) return null;
  return { title: fallback, usedFallback: true };
}

async function applyGeneratedSessionTitle(
  session: AgentSession,
  userInput: string,
  trigger: 'run_started' | 'stream_done',
  runId?: string,
): Promise<void> {
  const llmTitle = await resolveSessionTitleText(session.id, session.projectId, session.profileId, userInput);
  if (llmTitle && !isValidGeneratedSessionTitle(llmTitle.trim())) {
    logger.warn(
      { sessionId: session.id, runId: runId ?? null, trigger, llmTitle: llmTitle.trim() },
      '[session-title] generated title failed validation',
    );
  }

  const resolved = resolveFinalSessionTitle(llmTitle, userInput);
  if (!resolved) {
    logger.warn({ sessionId: session.id, runId: runId ?? null, trigger }, '[session-title] no usable title');
    return;
  }

  const current = agentRuntimeStore.tryGetSession(session.id);
  if (!current || current.title !== session.title) return;
  agentRuntimeStore.updateSession(session.id, {
    title: resolved.title,
    updatedAt: nowIso(),
    sessionMetadata: { ...(current.sessionMetadata ?? {}), titleSummarized: true },
  });
  logger.info(
    {
      sessionId: session.id,
      runId: runId ?? null,
      title: resolved.title,
      trigger,
      fallback: resolved.usedFallback,
    },
    '[session-title] session title updated',
  );
}

export function resolveInitialSessionTitle(input: {
  sessionMetadata: Record<string, unknown> | null;
  prompt: string;
}): string | null {
  const meta = input.sessionMetadata;
  if (meta?.source === 'session-page') {
    return DEFAULT_NEW_AGENT_SESSION_TITLE;
  }

  const fromGoal = resolveGoalTitleSource(input);
  if (fromGoal) return truncateInitialTitle(fromGoal);

  const prompt = input.prompt.trim();
  if (!prompt) return null;
  if (prompt.length <= 120 && !looksLikeSystemPrompt(prompt)) {
    return truncateInitialTitle(prompt);
  }
  return null;
}

export function needsGeneratedSessionTitle(session: AgentSession): boolean {
  if (session.sessionMetadata?.titleSummarized === true) return false;
  if (session.title?.trim() === DEFAULT_NEW_AGENT_SESSION_TITLE) return true;
  if (session.sessionMetadata?.source === 'session-page') return true;
  return !session.title?.trim();
}

/** Prefer stream_done so assistant context is available for synax title LLM. */
export function maybeScheduleSessionTitleFromStreamChunk(
  sessionId: string,
  chunk: AgentRunStreamChunk,
): void {
  if (chunk.type !== 'run_started') return;
  // Title generation runs on stream_done via ensureSessionTitleGenerated.
}

export function scheduleSessionTitleAfterRunStart(sessionId: string, runId: string): void {
  scheduleSessionTitleGeneration(sessionId, runId, 'run_started');
}

/** Reliable fallback: generate title after a streamed turn completes. */
export function ensureSessionTitleGenerated(sessionId: string): void {
  scheduleSessionTitleGeneration(sessionId, undefined, 'stream_done');
}

async function runSessionTitleGeneration(
  sessionId: string,
  runId: string | undefined,
  trigger: 'run_started' | 'stream_done',
): Promise<void> {
  try {
    const session = agentRuntimeStore.tryGetSession(sessionId);
    if (!session) {
      logger.debug({ sessionId, trigger }, '[session-title] skipped: session not found');
      return;
    }
    if (!needsGeneratedSessionTitle(session)) {
      logger.debug({ sessionId, trigger, title: session.title }, '[session-title] skipped: title already set');
      return;
    }
    if (session.activeRunId) {
      // A run is still in flight (for example the client stream ended before
      // the run did). Generating now would put a second model call in front of
      // the run itself; the run's completion triggers generation instead.
      logger.debug({ sessionId, trigger, activeRunId: session.activeRunId }, '[session-title] deferred: run still active');
      return;
    }

    const userInput = resolveUserTitleInput(sessionId, session.prompt);
    if (!userInput.trim()) {
      logger.debug({ sessionId, trigger }, '[session-title] skipped: no user input for title');
      return;
    }

    logger.info({ sessionId, runId: runId ?? null, trigger }, '[session-title] generating session title');
    await applyGeneratedSessionTitle(session, userInput, trigger, runId);
  } catch (err) {
    logger.warn({ sessionId, runId: runId ?? null, trigger, err }, '[session-title] generation failed');
  }
}

export async function resolveSessionTitleText(
  sessionId: string,
  projectId: string,
  profileId: string,
  userInput: string,
): Promise<string | null> {
  const ctx: TitleGeneratorContext = { sessionId, projectId, profileId, prompt: userInput };
  const custom = registry.get(profileId);

  if (custom) {
    const result = custom.generate(ctx);
    if (typeof result === 'string') {
      return result.trim() || null;
    }
    if (result && typeof (result as Promise<string | null>).then === 'function') {
      try {
        const title = await (result as Promise<string | null>);
        return title?.trim() || null;
      } catch (err) {
        logger.warn({ sessionId, err }, '[session-title] custom generator failed');
        return null;
      }
    }
  }

  return resolveTitleTextWithLlm(ctx);
}

/** @deprecated Prefer resolveSessionTitleText + a single updateSession for title persistence. */
export async function generateSessionTitle(
  sessionId: string,
  projectId: string,
  profileId: string,
  prompt: string,
): Promise<boolean> {
  const title = await resolveSessionTitleText(sessionId, projectId, profileId, prompt);
  if (!title) return false;
  agentRuntimeStore.updateSession(sessionId, { title, updatedAt: nowIso() });
  return true;
}

async function resolveTitleTextWithLlm(ctx: TitleGeneratorContext): Promise<string | null> {
  const usageId = startAuxUsage(ctx.sessionId, "session-title");
  try {
    const truncated = ctx.prompt.slice(0, 600);
    const result = await generateGatewayTextResult({
      projectId: ctx.projectId,
      purpose: 'session-title',
      messages: [
        {
          role: 'user',
          content: [
            'Generate a short title (max 10 Chinese characters or 6 English words) from the user input below.',
            'Return ONLY the title, no quotes or punctuation.',
            '',
            truncated,
          ].join('\n'),
        },
      ],
      maxTokens: 128,
      temperature: 0.3,
    });

    finishAuxUsage(usageId, result.totalUsage ?? result.usage);
    const title = (result.text ?? '').trim().slice(0, 50);
    return title || null;
  } catch (err) {
    finishAuxUsage(usageId);
    logger.warn({ sessionId: ctx.sessionId, err }, '[session-title] LLM title generation failed');
    return null;
  }
}

/**
 * Register the API-process hook that generates a title once a run completes.
 *
 * This is deliberately only called by the API process bootstrap: forked
 * session children emit `run:completed` too, and registering it there would
 * duplicate the model call.
 */
export function registerSessionTitleHooks(): void {
  sessionHooks.register({
    id: 'session-title-after-run',
    filter: { eventTypes: ['run:completed'] },
    handler: (event) => {
      if (event.type !== 'run:completed') return;
      ensureSessionTitleGenerated(event.sessionId);
    },
  });
}
