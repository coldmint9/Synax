import { useToastStore, type ToastType } from '../react/state/toastStore'

export type ErrorLevel = 'system' | 'business'

export type BusinessErrorCode =
  | 'RATE_LIMITED'
  | 'API_KEY_MISSING'
  | 'MODEL_UNAVAILABLE'
  | 'VALIDATION_FAILED'
  | 'SESSION_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'CONTEXT_LIMIT'
  | 'PROVIDER_ERROR'

const ERROR_MESSAGES: Record<string, string> = {
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  API_KEY_MISSING: 'LLM 服务未配置 API Key，请前往设置页完成配置',
  MODEL_UNAVAILABLE: '所选模型不可用，请检查配置或更换模型',
  VALIDATION_FAILED: '输入参数有误',
  SESSION_EXPIRED: '会话已过期，请刷新页面',
  PERMISSION_DENIED: '操作被拒绝',
  CONTEXT_LIMIT: '上下文已超出模型限制',
  PROVIDER_ERROR: 'LLM 服务调用失败，请检查 API Key 或网络',
}

const STATUS_TOAST_TYPE: Record<number, ToastType> = {
  429: 'warning',
  401: 'error',
  403: 'error',
  404: 'warning',
}

export class AppError extends Error {
  level: ErrorLevel
  code: string | undefined
  statusCode: number | undefined

  constructor(message: string, opts: { level: ErrorLevel; code?: string; statusCode?: number }) {
    super(message)
    this.name = 'AppError'
    this.level = opts.level
    this.code = opts.code
    this.statusCode = opts.statusCode
  }
}

export function classifyError(statusCode?: number, code?: string): ErrorLevel {
  if (statusCode && statusCode >= 500) return 'system'
  if (code && code in ERROR_MESSAGES) return 'business'
  if (statusCode === 429) return 'business'
  if (statusCode === 401 || statusCode === 403) return 'business'
  if (statusCode === 400 || statusCode === 422) return 'business'
  if (statusCode === 404) return 'business'
  if (!statusCode) return 'system'
  return 'business'
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && /fetch|network/i.test(err.message)) return true
  if (err instanceof DOMException && err.name === 'AbortError') return true
  return false
}

function toastTypeForError(err: AppError): ToastType {
  if (err.statusCode && err.statusCode in STATUS_TOAST_TYPE) {
    return STATUS_TOAST_TYPE[err.statusCode]
  }
  return 'error'
}

function userMessage(err: AppError): string {
  if (err.code && err.code in ERROR_MESSAGES) return ERROR_MESSAGES[err.code]
  return err.message
}

export function handleError(err: unknown): AppError {
  if (err instanceof AppError) {
    routeError(err)
    return err
  }

  if (isNetworkError(err)) {
    const appErr = new AppError('网络连接失败', { level: 'system' })
    routeError(appErr)
    return appErr
  }

  const raw = err instanceof Error ? err.message : String(err)
  const appErr = new AppError(raw, { level: 'business' })
  routeError(appErr)
  return appErr
}

function routeError(err: AppError): void {
  if (err.level === 'system') {
    console.error('[system]', err.message, err.code ?? '', err.statusCode ?? '')
    return
  }
  console.warn('[business]', err.message, err.code ?? '', err.statusCode ?? '')
  useToastStore.getState().push({
    id: `err-${Date.now().toString(36)}`,
    type: toastTypeForError(err),
    message: userMessage(err),
  })
}

export function createAppError(
  message: string,
  statusCode: number,
  code?: string,
): AppError {
  const level = classifyError(statusCode, code)
  return new AppError(message, { level, code, statusCode })
}

