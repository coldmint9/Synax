import { runtimeFacade } from './sidecar/runtime-facade.js';

let pending: Promise<void> | undefined;
let generation = 0;

/** Slow authoritative reads must not accumulate another scan every 15 seconds. */
export function recoverAnsweredInteractionsOnce(resume: (sessionId: string) => void): Promise<void> {
  return pending ??= recover(resume).finally(() => { pending = undefined; });
}

async function recover(resume: (sessionId: string) => void): Promise<void> {
  const current = generation;
  const projections = await runtimeFacade.listSessionProjection();
  for (const raw of projections) {
    if (current !== generation) break;
    if (!raw || typeof raw !== 'object') continue;
    const session = raw as { id?: unknown; status?: unknown; activeRunId?: unknown };
    if (typeof session.id !== 'string' || session.status !== 'waiting_input' || typeof session.activeRunId !== 'string') continue;
    const control = await runtimeFacade.controlState(session.id) as { interactions?: unknown[] };
    const answered = (control.interactions ?? []).some((item) => {
      if (!item || typeof item !== 'object') return false;
      const interaction = item as { runId?: unknown; status?: unknown; response?: unknown; consumedAt?: unknown };
      return interaction.runId === session.activeRunId && interaction.status !== 'pending' && interaction.response != null && !interaction.consumedAt;
    });
    if (answered && current === generation) resume(session.id);
  }
}

export function stopAnsweredInteractionRecovery(): Promise<void> {
  generation++;
  return pending?.catch(() => {}) ?? Promise.resolve();
}
