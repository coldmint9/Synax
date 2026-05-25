import { createAppError, handleError, AppError } from '../errors'

let apiOrigin = ''

export function getApiOrigin(): string {
  return apiOrigin
}

export async function initApiOrigin(): Promise<void> {
  const electronAPI = (window as any).electronAPI
  if (!electronAPI?.getApiPort) return

  const port = await electronAPI.getApiPort()
  if (port) {
    apiOrigin = `http://localhost:${port}`
  }
}

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiOrigin}${input}`, init)
}

export interface ApiRequestOptions extends RequestInit {
  silent?: boolean
}

export async function apiRequest<T>(
  path: string,
  init?: ApiRequestOptions,
): Promise<T> {
  const { silent, ...fetchInit } = init ?? {}
  let resp: Response
  try {
    resp = await apiFetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...fetchInit,
    })
  } catch (err) {
    if (!silent) handleError(err)
    throw err instanceof AppError ? err : new AppError(
      '网络连接失败',
      { level: 'system', statusCode: 0 },
    )
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

