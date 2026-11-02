import { logger } from '../../infrastructure/runtime/logger.js';
import { runtimeFacade } from './sidecar/runtime-facade.js';

/** A saved answer can only heal a session that still owns its run. */
export interface AnsweredInteractionHandlers {
  /** The parked run still owns its loop: answer it in place. */
  resume: (sessionId: string) => void;
  /** The run ended with the app: continue in a turn that carries the answer. */
  continue: (sessionId: string, interactionId: string) => Promise<void> | void;
}

/** A failed continuation must not be replayed forever on every scan. */
const CONTINUE_ATTEMPTS = 3;

let pending: Promise<void> | undefined;
let generation = 0;
const continued = new Map<string, number>();

/** Slow authoritative reads must not accumulate another scan every 15 seconds. */
export function recoverAnsweredInteractionsOnce(
  handlers: AnsweredInteractionHandlers,
): Promise<void> {
  return pending ??= recover(handlers).finally(() => { pending = undefined; });
}

function answeredInteraction(value: unknown):
  | { id: string; runId: string; kind: string; createdAt: string }
  | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const interaction = value as {
    id?: unknown;
    runId?: unknown;
    kind?: unknown;
    status?: unknown;
    response?: unknown;
    consumedAt?: unknown;
    createdAt?: unknown;
  };
  if (
    typeof interaction.id !== 'string' ||
    typeof interaction.runId !== 'string' ||
    interaction.status === 'pending' ||
    interaction.response == null ||
    interaction.consumedAt
  )
    return undefined;
  return {
    id: interaction.id,
    runId: interaction.runId,
    kind: typeof interaction.kind === 'string' ? interaction.kind : '',
    createdAt: typeof interaction.createdAt === 'string' ? interaction.createdAt : '',
  };
}

async function recover(handlers: AnsweredInteractionHandlers): Promise<void> {
  const current = generation;
  const projections = await runtimeFacade.listSessionProjection();
  for (const raw of projections) {
    if (current !== generation) break;
    if (!raw || typeof raw !== 'object') continue;
    const session = raw as { id?: unknown; status?: unknown; activeRunId?: unknown };
    if (typeof session.id !== 'string' || session.status !== 'waiting_input') continue;
    const control = await runtimeFacade.controlState(session.id) as { interactions?: unknown[] };
    const answered = (control.interactions ?? [])
      .map(item => answeredInteraction(item))
      .filter(item => item !== undefined);
    const activeRunId = typeof session.activeRunId === 'string' ? session.activeRunId : null;
    if (activeRunId) {
      // A live run only answers the checkpoint it owns.
      if (answered.some(item => item.runId === activeRunId) && current === generation)
        handlers.resume(session.id);
      continue;
    }
    // The session owns no live run, so only the newest saved form can be the
    // answer the restart left behind.
    const latest = answered
      .filter(item => item.kind === 'clarification')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!latest) continue;
    // The run died with the app while the answer was stored. The saved form is
    // the only way forward, and a plan approval cannot replay without its run
    // checkpoint, so only a clarification becomes a continuation turn.
    if (current !== generation) break;
    const key = `${session.id}:${latest.id}`;
    const failures = continued.get(key) ?? 0;
    if (failures >= CONTINUE_ATTEMPTS) continue;
    try {
      await handlers.continue(session.id, latest.id);
    } catch (error) {
      continued.set(key, failures + 1);
      logger.warn(
        { sessionId: session.id, interactionId: latest.id, error, failures: failures + 1 },
        'Answered form could not continue its session',
      );
    }
  }
}

export function stopAnsweredInteractionRecovery(): Promise<void> {
  generation++;
  continued.clear();
  return pending?.catch(() => {}) ?? Promise.resolve();
}
