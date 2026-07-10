import {
  createOfflineError,
  probeApiHealth,
  useApiConnectivityStore,
} from '../apiConnectivity'
import { createAppError, handleError } from '../errors'
import { AppError, isOfflineError } from '../appError'
import { getApiOrigin } from './originConfig'

export { getApiOrigin, initApiOrigin } from './originConfig'
export { isOfflineError }

/** Update reachability from an HTTP response.
 *  Vite proxy ECONNREFUSED often returns 500/502 — must not markSuccess or polling never stops. */
export function applyConnectivityFromResponse(resp: Response): void {
  if (resp.ok || (resp.status >= 400 && resp.status < 500)) {
    useApiConnectivityStore.getState().markSuccess()
    return
  }
  if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
    useApiConnectivityStore.getState().markFailure()
    return
  }
  if (resp.status >= 500) {
    // Ambiguous API 500 vs vite proxy 500 — fail closed, health probe recovers if API is up.
    useApiConnectivityStore.getState().markFailure()
    void probeApiHealth()
  }
}

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (useApiConnectivityStore.getState().shouldSkipRequest()) {
    return Promise.reject(createOfflineError())
  }

  return fetch(`${getApiOrigin()}${input}`, init).then(
    (resp) => {
      applyConnectivityFromResponse(resp)
      return resp
    },
    (err) => {
      useApiConnectivityStore.getState().markFailure()
      throw err
    },
  )
}

export interface ApiRequestOptions extends RequestInit {
  silent?: boolean
}

export async function apiRequest<T>(
  path: string,
  init?: ApiRequestOptions,
): Promise<T> {
  const { silent, ...fetchInit } = init ?? {}

  if (useApiConnectivityStore.getState().shouldSkipRequest()) {
    throw createOfflineError()
  }

  let resp: Response
  try {
    resp = await apiFetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...fetchInit,
    })
  } catch (err) {
    if (!silent) handleError(err)
    throw err instanceof AppError ? err : createOfflineError()
  }

  if (!resp.ok) {
    const { message, code } = await parseErrorBody(resp)
    const appErr = createAppError(message, resp.status, code)
    if (!silent) handleError(appErr)
    throw appErr
  }

  return resp.json() as Promise<T>
}

async function parseErrorBody(resp: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = await resp.json() as { error?: string; code?: string; message?: string }
    const code = body.code ?? undefined
    const message = body.error ?? body.message ?? `请求失败 (${resp.status})`
    return { message, code }
  } catch {
    return { message: `请求失败 (${resp.status})` }
  }
}
