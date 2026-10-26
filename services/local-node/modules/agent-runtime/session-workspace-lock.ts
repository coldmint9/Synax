const queues = new Map<string, Promise<void>>();

/** Serialize binding changes with run preparation; Rust supplies the durable fence. */
export async function withSessionWorkspaceLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  queues.set(sessionId, tail);
  await previous;
  try { return await action(); }
  finally { release(); if (queues.get(sessionId) === tail) queues.delete(sessionId); }
}
