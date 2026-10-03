/** Cancel our local wait even if a remote read ignores AbortSignal. This does
 * not claim to undo the remote request. Late fulfillment/rejection is consumed. */
export function waitForCodeRead<T>(
  result: T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(result);
  return new Promise<T>((resolve, reject) => {
    const cancel = () =>
      reject(signal.reason ?? new Error("Code Mode cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    Promise.resolve(result)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancel));
  });
}
