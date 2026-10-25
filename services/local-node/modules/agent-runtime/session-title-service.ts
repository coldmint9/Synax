import { normalizeResultUsage } from "../../infrastructure/llm-runtime/usage.js";
import { outsideExecutionContext } from "../../infrastructure/runtime/execution-context.js";
import { startAuxUsage, finishAuxUsage } from "./usage-projection.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import { sessionHooks } from "./session-hooks.js";
import { generateGatewayTextResult } from "../../infrastructure/llm-runtime/gateway.js";
import { resolveSessionTitleInput } from "./session-title-input.js";
import { isSessionComposerSource } from "./session-metadata.js";
import type { AgentRunStreamChunk, AgentSession } from "./contracts.js";
import { agentRuntimeStore } from "./session-store.js";
import { nowIso } from "./runtime-ids.js";

function resolveUserTitleInput(
  sessionId: string,
  sessionPrompt: string,
): string {
  const session = agentRuntimeStore.tryGetSession(sessionId);
  return (
    resolveSessionTitleInput({
      sessionMetadata: session?.sessionMetadata ?? null,
      prompt: sessionPrompt,
    }) ?? sessionPrompt.trim()
  );
}

const INITIAL_TITLE_MAX_LEN = 80;
export const DEFAULT_NEW_SESSION_TITLE = "new session";

/**
 * Titles that only mean "no title yet". Legacy spellings stay
 * recognized so sessions created before the rename still get summarized.
 */
const PLACEHOLDER_SESSION_TITLES = [
  DEFAULT_NEW_SESSION_TITLE,
  "new chat",
  "new agent",
  "新会话",
  "新对话",
];

function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  const normalized = title?.trim().toLowerCase();
  if (!normalized) return false;
  return PLACEHOLDER_SESSION_TITLES.some(
    (placeholder) => placeholder.toLowerCase() === normalized,
  );
}

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
const titleOutputSeen = new Set<string>();

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
  trigger: "first_output" | "stream_done",
): void {
  if (titleGenerationInFlight.has(sessionId)) {
    // A generation is already running; re-check once it settles so a title
    // is still produced if that attempt failed to persist one.
    titleGenerationQueued.add(sessionId);
    return;
  }
  const task = outsideExecutionContext(() =>
    runDeferredSessionTitleGeneration(sessionId, runId, trigger),
  );
  titleGenerationInFlight.set(sessionId, task);
  void task.finally(() => {
    titleGenerationInFlight.delete(sessionId);
    if (titleGenerationQueued.delete(sessionId)) {
      scheduleSessionTitleGeneration(sessionId, undefined, "stream_done");
    }
  });
}

async function runDeferredSessionTitleGeneration(
  sessionId: string,
  runId: string | undefined,
  trigger: "first_output" | "stream_done",
): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await runSessionTitleGeneration(sessionId, runId, trigger);
}

export function registerTitleGenerator(
  profileId: string,
  generator: TitleGenerator,
): void {
  registry.set(profileId, generator);
}

export function unregisterTitleGenerator(profileId: string): void {
  registry.delete(profileId);
}

function looksLikeSystemPrompt(prompt: string): boolean {
  return prompt.includes("## ") || /^You are\b/m.test(prompt);
}

function truncateInitialTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= INITIAL_TITLE_MAX_LEN) return trimmed;
  return `${trimmed.slice(0, INITIAL_TITLE_MAX_LEN - 1)}…`;
}

function fallbackTitleFromUserInput(userInput: string): string | null {
  const trimmed = userInput.trim();
  if (!trimmed || isPlaceholderSessionTitle(trimmed)) return null;
  if (looksLikeSystemPrompt(trimmed)) return null;
  return truncateInitialTitle(trimmed);
}

/** Short requests can serve as provisional titles outside the session composer. */
export function shortSessionTitle(userInput: string): string | null {
  const text = userInput.trim();
  return text &&
    text.length <= 80 &&
    [...text].length <= 40 &&
    !/[\r\n]/.test(text) &&
    !looksLikeSystemPrompt(text) &&
    !isPlaceholderSessionTitle(text)
    ? text
    : null;
}

const MAX_GENERATED_CJK_CHARS = 10;
const MAX_GENERATED_ENGLISH_WORDS = 6;
const MAX_GENERATED_TITLE_LEN = 50;

function countCjkChars(text: string): number {
  return [...text].filter((ch) => /\p{Script=Han}/u.test(ch)).length;
}

function countEnglishWords(text: string): number {
  const latin = text.replace(/\p{Script=Han}/gu, " ").trim();
  if (!latin) return 0;
  return latin.split(/\s+/).filter(Boolean).length;
}

/** Validate LLM-generated titles against prompt constraints. */
export function isValidGeneratedSessionTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > MAX_GENERATED_TITLE_LEN) return false;
  if (isPlaceholderSessionTitle(trimmed)) return false;
  if (/[\n\r]/.test(trimmed)) return false;
  if (looksLikeSystemPrompt(trimmed)) return false;
  if (/^["'`「『【〈《[]/.test(trimmed) && /["'`」』】〉》\])]$/.test(trimmed))
    return false;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return false;

  const cjkCount = countCjkChars(trimmed);
  const wordCount = countEnglishWords(trimmed);
  if (cjkCount > 0 && wordCount === 0)
    return cjkCount <= MAX_GENERATED_CJK_CHARS;
  if (wordCount > 0 && cjkCount === 0)
    return wordCount >= 1 && wordCount <= MAX_GENERATED_ENGLISH_WORDS;
  return (
    cjkCount <= MAX_GENERATED_CJK_CHARS &&
    wordCount <= MAX_GENERATED_ENGLISH_WORDS
  );
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
  trigger: "first_output" | "stream_done",
  runId?: string,
): Promise<void> {
  const llmTitle = await resolveSessionTitleText(
    session.id,
    session.projectId,
    session.profileId,
    userInput,
  );
  if (llmTitle && !isValidGeneratedSessionTitle(llmTitle.trim())) {
    logger.warn(
      {
        sessionId: session.id,
        runId: runId ?? null,
        trigger,
        llmTitle: llmTitle.trim(),
      },
      "[session-title] generated title failed validation",
    );
  }

  const resolved = resolveFinalSessionTitle(llmTitle, userInput);
  if (!resolved) {
    logger.warn(
      { sessionId: session.id, runId: runId ?? null, trigger },
      "[session-title] no usable title",
    );
    return;
  }

  const current = agentRuntimeStore.tryGetSession(session.id);
  if (
    !current ||
    current.sessionMetadata?.titleSource === "user" ||
    current.title !== session.title ||
    resolveUserTitleInput(current.id, current.prompt) !== userInput
  )
    return;
  agentRuntimeStore.updateSession(session.id, {
    title: resolved.title,
    updatedAt: nowIso(),
    sessionMetadata: {
      ...(current.sessionMetadata ?? {}),
      titleSummarized: true,
    },
  });
  // Title generation runs outside the request/turn lifecycle. Wait for this
  // session's queued Rust patch so a normal app close cannot discard a title
  // that was already reported as updated.
  await agentRuntimeStore.flushSession(session.id);
  logger.info(
    {
      sessionId: session.id,
      runId: runId ?? null,
      title: resolved.title,
      trigger,
      fallback: resolved.usedFallback,
    },
    "[session-title] session title updated",
  );
}

export function resolveInitialSessionTitle(input: {
  sessionMetadata: Record<string, unknown> | null;
  prompt: string;
}): string | null {
  const meta = input.sessionMetadata;
  if (isSessionComposerSource(meta?.source)) {
    return DEFAULT_NEW_SESSION_TITLE;
  }
  const direct = shortSessionTitle(
    resolveSessionTitleInput(input) ?? input.prompt,
  );
  if (direct) return direct;

  const userInput = resolveSessionTitleInput(input);
  if (userInput) return truncateInitialTitle(userInput);

  const prompt = input.prompt.trim();
  if (!prompt) return null;
  if (prompt.length <= 120 && !looksLikeSystemPrompt(prompt)) {
    return truncateInitialTitle(prompt);
  }
  return null;
}

/** A trailing `(n)` is a fork counter, not part of the user's own title. */
const FORK_TITLE_COUNTER = /^(.*?)\s*\((\d+)\)$/;
const FORK_TITLE_FIRST_COUNTER = 2;

function withForkCounter(base: string, counter: number): string {
  const suffix = `(${counter})`;
  const room = INITIAL_TITLE_MAX_LEN - suffix.length;
  return `${base.length <= room ? base : `${base.slice(0, room - 1)}…`}${suffix}`;
}

/**
 * Title for a session forked from `sourceTitle`.
 *
 * A fork keeps its source's prompt, so copying the title would leave two
 * sessions with the same name in the list. Use the first free `base(n)`
 * (n >= 2) instead, which reuses numbers that became free when a fork was
 * deleted. Placeholder titles are left untouched: they carry no real name yet,
 * and a counter would freeze them before the generated title arrives.
 *
 * Returns null when the source title needs no change.
 */
export function forkSessionTitle(input: {
  sourceTitle: string | null | undefined;
  existingTitles: Iterable<string | null | undefined>;
}): string | null {
  const source = input.sourceTitle?.trim();
  if (!source || isPlaceholderSessionTitle(source)) return null;
  const base = (FORK_TITLE_COUNTER.exec(source)?.[1] ?? source).trim();
  if (!base) return null;
  const taken = new Set<string>();
  for (const title of input.existingTitles) {
    const candidate = title?.trim();
    if (candidate) taken.add(candidate);
  }
  for (
    let counter = FORK_TITLE_FIRST_COUNTER;
    counter < FORK_TITLE_FIRST_COUNTER + 10_000;
    counter += 1
  ) {
    const candidate = withForkCounter(base, counter);
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

export function needsGeneratedSessionTitle(session: AgentSession): boolean {
  if (session.sessionMetadata?.titleSource === "user") return false;
  if (session.sessionMetadata?.titleSummarized === true) return false;
  if (isPlaceholderSessionTitle(session.title)) return true;
  return !session.title?.trim();
}

/** Schedule only after useful model output; startup must belong to the foreground request. */
export function maybeScheduleSessionTitleFromStreamChunk(
  sessionId: string,
  chunk: AgentRunStreamChunk,
): void {
  if (chunk.type === 'run_started') { titleOutputSeen.delete(sessionId); return; }
  if (titleOutputSeen.has(sessionId) || titleGenerationInFlight.has(sessionId)) return;
  const useful = ((chunk.type === "message_delta" || chunk.type === "thought_delta") && chunk.delta.length > 0)
    || chunk.type === "tool_call"
    || (chunk.type === "message" && chunk.message.role === "assistant" && chunk.message.content.length > 0);
  if (!useful) return;
  titleOutputSeen.add(sessionId);
  if (titleOutputSeen.size > 1024) titleOutputSeen.delete(titleOutputSeen.values().next().value!);
  const session = agentRuntimeStore.tryGetSession(sessionId);
  if (!session || !needsGeneratedSessionTitle(session)) return;
  scheduleSessionTitleAfterFirstOutput(sessionId, "runId" in chunk ? chunk.runId : undefined);
}

export function scheduleSessionTitleAfterFirstOutput(sessionId: string, runId?: string): void {
  scheduleSessionTitleGeneration(sessionId, runId, "first_output");
}

/** Reliable fallback: generate title after a streamed turn completes. */
export function ensureSessionTitleGenerated(sessionId: string): void {
  scheduleSessionTitleGeneration(sessionId, undefined, "stream_done");
}

async function runSessionTitleGeneration(
  sessionId: string,
  runId: string | undefined,
  trigger: "first_output" | "stream_done",
): Promise<void> {
  try {
    const session = agentRuntimeStore.tryGetSession(sessionId);
    if (!session) {
      logger.debug(
        { sessionId, trigger },
        "[session-title] skipped: session not found",
      );
      return;
    }
    if (!needsGeneratedSessionTitle(session)) {
      logger.debug(
        { sessionId, trigger, title: session.title },
        "[session-title] skipped: title already set",
      );
      return;
    }
    if (session.activeRunId && trigger !== "first_output") {
      // A late fallback fired while the run is still in flight (for example
      // the client stream ended before the run did). The first-output trigger
      // is intentionally allowed to overlap the first turn.
      logger.debug(
        { sessionId, trigger, activeRunId: session.activeRunId },
        "[session-title] deferred: run still active",
      );
      return;
    }

    const userInput = resolveUserTitleInput(sessionId, session.prompt);
    if (!userInput.trim()) {
      logger.debug(
        { sessionId, trigger },
        "[session-title] skipped: no user input for title",
      );
      return;
    }

    logger.info(
      { sessionId, runId: runId ?? null, trigger },
      "[session-title] generating session title",
    );
    await applyGeneratedSessionTitle(session, userInput, trigger, runId);
  } catch (err) {
    logger.warn(
      { sessionId, runId: runId ?? null, trigger, err },
      "[session-title] generation failed",
    );
  }
}

export async function resolveSessionTitleText(
  sessionId: string,
  projectId: string,
  profileId: string,
  userInput: string,
): Promise<string | null> {
  const ctx: TitleGeneratorContext = {
    sessionId,
    projectId,
    profileId,
    prompt: userInput,
  };
  const custom = registry.get(profileId);

  if (custom) {
    const result = custom.generate(ctx);
    if (typeof result === "string") {
      return result.trim() || null;
    }
    if (
      result &&
      typeof (result as Promise<string | null>).then === "function"
    ) {
      try {
        const title = await (result as Promise<string | null>);
        return title?.trim() || null;
      } catch (err) {
        logger.warn(
          { sessionId, err },
          "[session-title] custom generator failed",
        );
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
  const before = agentRuntimeStore.tryGetSession(sessionId);
  if (!before) return false;
  const title = await resolveSessionTitleText(
    sessionId,
    projectId,
    profileId,
    prompt,
  );
  const current = agentRuntimeStore.tryGetSession(sessionId);
  if (!title || !current || current.sessionMetadata?.titleSource === "user" || current.title !== before.title) return false;
  agentRuntimeStore.updateSession(sessionId, { title, updatedAt: nowIso() });
  return true;
}

async function resolveTitleTextWithLlm(
  ctx: TitleGeneratorContext,
): Promise<string | null> {
  const usageId = startAuxUsage(ctx.sessionId, "session-title");
  try {
    const truncated = ctx.prompt.slice(0, 600);
    const result = await generateGatewayTextResult({
      projectId: ctx.projectId,
      purpose: "session-title",
      messages: [
        {
          role: "user",
          content: [
            "Generate a short title (max 10 Chinese characters or 6 English words) from the user input below.",
            "Return ONLY the title, no quotes or punctuation.",
            "",
            truncated,
          ].join("\n"),
        },
      ],
      maxTokens: 2048,
      maxRetries: 0,
      temperature: 0.3,
    }, AbortSignal.timeout(22_000));

    finishAuxUsage(usageId, normalizeResultUsage(result));
    const title = (result.text ?? "").trim().slice(0, 50);
    return title || null;
  } catch (err) {
    finishAuxUsage(usageId);
    logger.warn(
      { sessionId: ctx.sessionId, err },
      "[session-title] LLM title generation failed",
    );
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
    id: "session-title-after-run",
    filter: { eventTypes: ["run:completed"] },
    handler: (event) => {
      if (event.type !== "run:completed") return;
      ensureSessionTitleGenerated(event.sessionId);
    },
  });
}
