/**
 * Run async work over items with a fixed concurrency ceiling.
 * Preserves input order only for scheduling; completion order is undefined.
 * Fails fast: the first worker error aborts remaining scheduling and is rethrown.
 */
export async function runBoundedConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  if (items.length === 0) return;

  let cursor = 0;
  let failure: unknown;

  const runSlot = async (): Promise<void> => {
    while (cursor < items.length && failure === undefined) {
      const index = cursor++;
      const item = items[index];
      try {
        await worker(item, index);
      } catch (err) {
        failure = err;
        return;
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runSlot());
  await Promise.all(workers);

  if (failure !== undefined) {
    throw failure;
  }
}
