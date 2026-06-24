export type ErrorLevel = 'system' | 'business'

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

export function createOfflineError(message = '网络连接失败，无法访问后端服务'): AppError {
  return new AppError(message, { level: 'system', statusCode: 0, code: 'NETWORK_OFFLINE' })
}

export function isOfflineError(err: unknown): boolean {
  return err instanceof AppError && err.code === 'NETWORK_OFFLINE'
}
