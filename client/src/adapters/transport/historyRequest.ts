import { apiRequest } from "./origin";

export const HISTORY_REQUEST_TIMEOUT_MS = 30_000;

/** Bound the entire read, including authentication and response-body decoding. */
export async function requestHistory<T>(path: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error("History request timed out. Please retry."), {
        code: "HISTORY_TIMEOUT",
      });
      controller.abort(error);
      reject(error);
    }, HISTORY_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      apiRequest<T>(path, { silent: true, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
