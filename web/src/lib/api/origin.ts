import {
  ensureRuntimeAuthentication,
  runtimeAuthHeaders,
  runtimeAuthEnabled,
  resetRuntimeAuthentication,
  notifyRuntimeAuthenticationRequired,
} from "./runtimeAuth";
import {
  createOfflineError,
  useApiConnectivityStore,
} from "../apiConnectivity";
import { createAppError, handleError } from "../errors";
import { AppError, isAbortError, isOfflineError } from "../appError";
import { getApiOrigin } from "./originConfig";

export { getApiOrigin, initApiOrigin } from "./originConfig";
export { isOfflineError };

/** Endpoint-level 5xx failures stay local to that request. Only transport
 * failures and the dedicated health probe are allowed to mark the API offline. */
export function applyConnectivityFromResponse(resp: Response): void {
  if (resp.ok || (resp.status >= 400 && resp.status < 500)) {
    useApiConnectivityStore.getState().markSuccess();
  }
}

export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  if (useApiConnectivityStore.getState().shouldSkipRequest())
    throw createOfflineError();
  const origin = getApiOrigin();
  let url = `${origin}${input}`;
  if (/^https?:/.test(input)) {
    const expected =
      origin || (typeof window !== "undefined" ? window.location.origin : "");
    if (!expected || new URL(input).origin !== new URL(expected).origin)
      throw new Error(
        "Refusing to send runtime credentials to another origin.",
      );
    url = input;
  } else if (!input.startsWith("/api/") && input !== "/api")
    throw new Error("Runtime requests must target the API.");
  await ensureRuntimeAuthentication();
  init?.signal?.throwIfAborted();
  const send = () => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(runtimeAuthHeaders()))
      headers.set(name, value);
    return fetch(url, { ...init, credentials: "include", headers });
  };
  try {
    let response = await send();
    if (response.status === 401 && runtimeAuthEnabled()) {
      resetRuntimeAuthentication();
      try {
        await ensureRuntimeAuthentication();
        response = await send();
      } catch {
        notifyRuntimeAuthenticationRequired();
      }
    }
    init?.signal?.throwIfAborted();
    applyConnectivityFromResponse(response);
    return response;
  } catch (error) {
    // Closing or replacing an observation stream is not a network outage.
    if (!init?.signal?.aborted)
      useApiConnectivityStore.getState().markFailure(true);
    throw error;
  }
}

export interface ApiRequestOptions extends RequestInit {
  silent?: boolean;
}

export async function apiRequest<T>(
  path: string,
  init?: ApiRequestOptions,
): Promise<T> {
  const { silent, ...fetchInit } = init ?? {};

  if (useApiConnectivityStore.getState().shouldSkipRequest()) {
    throw createOfflineError();
  }

  let resp: Response;
  try {
    resp = await apiFetch(path, {
      headers: { "Content-Type": "application/json" },
      ...fetchInit,
    });
  } catch (err) {
    // Replacing a debounced request is expected control flow, not an outage.
    // Preserve AbortError so consumers can ignore stale work without poisoning
    // the process-wide connectivity state.
    if (fetchInit.signal?.aborted || isAbortError(err)) {
      throw err;
    }
    if (!silent) handleError(err);
    throw err instanceof AppError ? err : createOfflineError();
  }

  if (!resp.ok) {
    const { message, code } = await parseErrorBody(resp);
    const appErr = createAppError(message, resp.status, code);
    if (!silent) handleError(appErr);
    throw appErr;
  }

  return resp.json() as Promise<T>;
}

async function parseErrorBody(
  resp: Response,
): Promise<{ message: string; code?: string }> {
  try {
    const body = (await resp.json()) as {
      error?: string;
      code?: string;
      message?: string;
    };
    const code = body.code ?? undefined;
    const message = body.error ?? body.message ?? `请求失败 (${resp.status})`;
    return { message, code };
  } catch {
    return { message: `请求失败 (${resp.status})` };
  }
}
