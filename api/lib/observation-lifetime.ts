/** Register cancellation before the first awaited write/snapshot. A reader may
 * unsubscribe while that promise is pending; late abort listeners would leak. */
export function observationLifetime(request: AbortSignal, stream: { onAbort(callback: () => void): void }) {
  const controller = new AbortController();
  let resolve!: () => void;
  const ended = new Promise<void>(done => { resolve = done; });
  const stop = () => { if (!controller.signal.aborted) { controller.abort(); resolve(); } };
  request.addEventListener("abort", stop, { once: true });
  stream.onAbort(stop);
  if (request.aborted) stop();
  return { signal: controller.signal, ended, stop, dispose: () => { stop(); request.removeEventListener("abort", stop); } };
}
