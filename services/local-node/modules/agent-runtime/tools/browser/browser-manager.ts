import { BrowserSession, type BrowserSessionConfig } from "./browser-session.js";

/**
 * One browser per agent session, keyed by session ID. Each agent session runs
 * in its own worker process, so this map only ever holds that session's browser
 * plus any tools executed in the host process; the idle sweep below is what
 * keeps a finished session from pinning a Chromium forever.
 */
const sessions = new Map<string, BrowserSession>();

/** Bounded concurrent Chromium installs across sessions in this process. */
const MAX_BROWSER_SESSIONS = 4;
const IDLE_TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

let sweeper: ReturnType<typeof setInterval> | null = null;

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    void sweepIdleSessions();
  }, SWEEP_INTERVAL_MS);
  // Never keep the host process alive just for the sweep.
  sweeper.unref?.();
}

async function sweepIdleSessions(): Promise<void> {
  for (const [sessionId, session] of sessions) {
    if (session.idleMs < IDLE_TTL_MS) continue;
    sessions.delete(sessionId);
    await session
      .dispose(`Idle for over ${Math.round(IDLE_TTL_MS / 60_000)} minutes.`)
      .catch(() => undefined);
  }
}

export function getBrowserSession(sessionId: string): BrowserSession | undefined {
  const session = sessions.get(sessionId);
  return session && !session.disposed ? session : undefined;
}

export async function acquireBrowserSession(
  config: BrowserSessionConfig,
): Promise<BrowserSession> {
  const existing = sessions.get(config.sessionId);
  if (existing && !existing.disposed) {
    // `headless` only applies to a fresh launch; a running browser keeps its mode.
    existing.touch();
    return existing;
  }
  if (sessions.size >= MAX_BROWSER_SESSIONS) {
    // Prefer evicting the most idle session over failing the tool call.
    const oldest = [...sessions.entries()].sort(
      (a, b) => b[1].idleMs - a[1].idleMs,
    )[0];
    if (oldest) {
      sessions.delete(oldest[0]);
      await oldest[1].dispose("Evicted: too many concurrent browser sessions.").catch(
        () => undefined,
      );
    }
  }
  const session = new BrowserSession(config);
  sessions.set(config.sessionId, session);
  startSweeper();
  return session;
}

export async function closeBrowserSession(
  sessionId: string,
  reason: string,
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  await session.dispose(reason).catch(() => undefined);
}

/** Called from worker and host shutdown paths; must never throw. */
export async function closeAllBrowserSessions(reason: string): Promise<void> {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  const closing = [...sessions.entries()].map(async ([sessionId, session]) => {
    sessions.delete(sessionId);
    await session.dispose(reason).catch(() => undefined);
  });
  await Promise.all(closing);
}

/** Test hook: drop all state without waiting on real browsers. */
export function resetBrowserSessionsForTests(): void {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  sessions.clear();
}
