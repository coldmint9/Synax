/** A shared lease limit for both Web and desktop, with explicit recent-use priority. */
const leases = new Map<string, () => Promise<void>>();
let pending = Promise.resolve();
export function acquirePreviewSlot(
  id: string,
  pause: () => Promise<void>,
): Promise<void> {
  const next = pending.then(async () => {
    if (leases.has(id)) {
      leases.delete(id);
      leases.set(id, pause);
      return;
    }
    while (leases.size >= 2) {
      const oldest = leases.entries().next().value!;
      leases.delete(oldest[0]);
      await oldest[1]();
    }
    leases.set(id, pause);
  });
  pending = next.catch(() => {});
  return next;
}
export function releasePreviewSlot(id: string) {
  leases.delete(id);
}
export function touchPreviewSlot(id: string) {
  const pause = leases.get(id);
  if (pause) {
    leases.delete(id);
    leases.set(id, pause);
  }
}
