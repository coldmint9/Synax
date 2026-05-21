import { Hono } from 'hono'
import * as z from 'zod/v4'
import { existsSync } from 'node:fs'
import { execFile, execSync } from 'node:child_process'
import {
  deleteProjectConfig,
  getEffectiveConfigForDisplay,
  getGlobalConfig,
  getGlobalConfigForRuntime,
  getProjectConfig,
  listAvailableProviders,
  updateGlobalConfig,
  upsertProjectConfig,
} from '../lib/config/config-store.js'
import { logger } from '../lib/logger.js'
import type {
  AiApiModelsDiscoverResponse,
  ApiFormat,
  UpdateGlobalConfigRequest,
} from '../lib/config/config-types.js'
import { discoverAcpProviders } from '../services/acp/discovery.js'
import { listProviders as listAcpProviders } from '../services/acp/index.js'

export const configRoutes = new Hono()

const ACP_PROVIDER_IDS = ['opencode-acp', 'cursor-acp'] as const
const BUILTIN_API_PROVIDER_IDS = ['openai', 'anthropic'] as const
const CUSTOM_API_PROVIDER_PREFIX = 'custom-api:'

const providerConnectionSchema = z
  .object({
    providerId: z.string().min(1),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    apiKeyMasked: z.string().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

const providerDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['live', 'experimental', 'inactive']),
  kind: z.enum(['acp', 'api']),
  caps: z.object({
    canFollowUp: z.boolean(),
    canCancel: z.boolean(),
  }),
  models: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      isDefault: z.boolean().optional(),
      maxTokens: z.number().optional(),
    }),
  ),
  connectionSchema: z.record(z.string(), z.unknown()).optional(),
})

const globalConfigPatchSchema = z
  .object({
    providers: z.array(providerDefSchema).optional(),
    defaultProviderId: z.enum(ACP_PROVIDER_IDS).optional(),
    defaultApiProviderId: z.string().min(1).optional(),
    providerConnections: z.record(z.string(), providerConnectionSchema).optional(),
    limits: z
      .object({
        maxAgentsPerProject: z.number().int().positive(),
        maxSessionsPerUser: z.number().int().positive(),
        agentTimeoutMs: z.number().int().positive(),
      })
      .partial()
      .optional(),
    features: z
      .object({
        allowProjectConnectionOverride: z.boolean(),
        allowMultiProvider: z.boolean(),
      })
      .partial()
      .optional(),
  })
  .strict()

const aiApiValidateSchema = z.object({
  providerId: z.string().min(1).optional(),
  format: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1),
})

const aiApiModelsDiscoverSchema = z.object({
  providerId: z.string().min(1).optional(),
  format: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).optional(),
})

configRoutes.get('/global', (c) => {
  const config = getGlobalConfig()
  return c.json({ config })
})

configRoutes.put('/global', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const updatedBy = c.req.header('X-User-Name') ?? c.req.header('X-User-Id') ?? 'api'

  let parsed: UpdateGlobalConfigRequest
  try {
    parsed = validateGlobalConfigPatch(body)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err: message }, '[config] global config update rejected')
    return c.json({ error: message }, 400)
  }

  try {
    const config = updateGlobalConfig(parsed, updatedBy)
    logger.info({ updatedBy }, '[config] global config updated')
    return c.json({ config })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err: message }, '[config] global config update failed')
    return c.json({ error: message }, 500)
  }
})

configRoutes.get('/global/providers', (c) => {
  const providers = listAvailableProviders()
  return c.json({
    providers: providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      status: provider.status,
      kind: provider.kind,
      caps: provider.caps,
      models: provider.models,
    })),
  })
})

configRoutes.get('/acp/discovery', async (c) => {
  const global = getGlobalConfig()
  const providers = listAcpProviders()
  const items = await discoverAcpProviders(providers, global.defaultProviderId)
  return c.json({
    selectedProviderId: global.defaultProviderId,
    supported: items,
  })
})

configRoutes.post('/ai-api/validate', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400)
  }

  const parsed = aiApiValidateSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ ok: false, error: 'Validation failed', details: parsed.error.flatten() }, 400)
  }

  try {
    const result = await validateAiApi(parsed.data)
    return c.json(result, result.ok ? 200 : 400)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err: message }, '[config] ai api validation failed')
    return c.json({ ok: false, error: message }, 400)
  }
})

configRoutes.post('/ai-api/models/discover', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, models: [], source: 'api/models', error: 'Invalid JSON body' }, 400)
  }

  const parsed = aiApiModelsDiscoverSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ ok: false, models: [], source: 'api/models', error: 'Validation failed' }, 400)
  }

  try {
    const result = await discoverAiApiModels(parsed.data)
    return c.json(result, result.ok ? 200 : 400)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err: message }, '[config] ai api model discovery failed')
    return c.json({ ok: false, models: [], source: 'api/models', error: message }, 400)
  }
})

configRoutes.get('/projects/:projectId/config', (c) => {
  const projectId = c.req.param('projectId')
  if (!projectId) return c.json({ error: 'Missing projectId' }, 400)

  const config = getProjectConfig(projectId)
  return c.json({ config })
})

configRoutes.put('/projects/:projectId/config', async (c) => {
  const projectId = c.req.param('projectId')
  if (!projectId) return c.json({ error: 'Missing projectId' }, 400)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const updatedBy = c.req.header('X-User-Name') ?? c.req.header('X-User-Id') ?? 'api'

  try {
    const config = upsertProjectConfig(projectId, body as any, updatedBy)
    logger.info({ projectId, updatedBy }, '[config] project config updated')
    return c.json({ config })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err: message, projectId }, '[config] project config update failed')
    return c.json({ error: message }, 500)
  }
})

configRoutes.delete('/projects/:projectId/config', (c) => {
  const projectId = c.req.param('projectId')
  if (!projectId) return c.json({ error: 'Missing projectId' }, 400)

  const deleted = deleteProjectConfig(projectId)
  return c.json({ deleted })
})

configRoutes.get('/projects/:projectId/config/effective', (c) => {
  const projectId = c.req.param('projectId')
  if (!projectId) return c.json({ error: 'Missing projectId' }, 400)

  try {
    const config = getEffectiveConfigForDisplay(projectId)
    return c.json({ config })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err: message, projectId }, '[config] effective config failed')
    return c.json({ error: message }, 500)
  }
})

// ── Open file in system default editor ──────────────────────────────────────

configRoutes.post('/open-file', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.filePath !== 'string' || !body.filePath) {
    return c.json({ error: 'Missing filePath' }, 400)
  }

  const { filePath, line } = body as { filePath: string; line?: number }
  if (!existsSync(filePath)) {
    return c.json({ error: 'File not found' }, 404)
  }

  const cmd = buildOpenFileCommand(filePath, line ?? undefined)

  return new Promise((resolve) => {
    execFile(cmd.bin, cmd.args, (err) => {
      if (err) {
        logger.error({ err: err.message, filePath, line }, '[config] open-file failed')
        resolve(c.json({ error: err.message }, 500))
      } else {
        resolve(c.json({ ok: true }))
      }
    })
  })
})

function buildOpenFileCommand(filePath: string, line?: number): { bin: string; args: string[] } {
  const platform = process.platform

  function which(bin: string): string | null {
    try {
      return execSync(`which ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
    } catch { return null }
  }

  const editorBins = ['code', 'cursor', 'windsurf'] as const
  for (const bin of editorBins) {
    const path = which(bin)
    if (path) {
      return line
        ? { bin: path, args: ['--goto', `${filePath}:${line}`] }
        : { bin: path, args: [filePath] }
    }
  }

  const sublPath = which('subl')
  if (sublPath) {
    return { bin: sublPath, args: [line ? `${filePath}:${line}` : filePath] }
  }

  if (platform === 'darwin') return { bin: '/usr/bin/open', args: [filePath] }
  if (platform === 'win32') return { bin: 'cmd', args: ['/c', 'start', '', filePath] }
  return { bin: 'xdg-open', args: [filePath] }
}

function validateGlobalConfigPatch(body: unknown): UpdateGlobalConfigRequest {
  const parsed = globalConfigPatchSchema.safeParse(body)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new Error(first ? `配置参数无效: ${first.path.join('.') || 'body'} ${first.message}` : '配置参数无效')
  }

  const patch = parsed.data
  const current = getGlobalConfig()
  const nextProviders = patch.providers ?? current.providers
  const providerMap = new Map(nextProviders.map((provider) => [provider.id, provider]))

  for (const official of [...ACP_PROVIDER_IDS, ...BUILTIN_API_PROVIDER_IDS]) {
    if (!providerMap.has(official)) {
      throw new Error(`官方 provider 不可删除: ${official}`)
    }
  }

  for (const provider of nextProviders) {
    if (isAcpProviderId(provider.id) && provider.kind !== 'acp') {
      throw new Error(`${provider.id} 必须是 ACP provider`)
    }
    if (isApiProviderId(provider.id) && provider.kind !== 'api') {
      throw new Error(`${provider.id} 必须是 API provider`)
    }
    if (!isAcpProviderId(provider.id) && !isApiProviderId(provider.id)) {
      throw new Error(`不支持的 provider: ${provider.id}`)
    }
  }

  const mergedConnections = {
    ...current.providerConnections,
    ...(patch.providerConnections ?? {}),
  }

  for (const [providerId, connection] of Object.entries(patch.providerConnections ?? {})) {
    if (connection.providerId !== providerId) {
      throw new Error(`${providerId} 的 providerId 必须与连接 key 一致`)
    }
    if (!providerMap.has(providerId)) {
      throw new Error(`provider connection 未匹配 provider: ${providerId}`)
    }
    validateProviderConnection(providerId, connection, current.providerConnections[providerId])
  }

  const defaultAcpProviderId = patch.defaultProviderId ?? current.defaultProviderId
  if (!isAcpProviderId(defaultAcpProviderId)) {
    throw new Error('默认 ACP provider 只能是 opencode-acp 或 cursor-acp')
  }

  const defaultApiProviderId = patch.defaultApiProviderId ?? current.defaultApiProviderId
  if (!providerMap.has(defaultApiProviderId)) {
    throw new Error(`默认 API provider 不存在: ${defaultApiProviderId}`)
  }
  const defaultApiProvider = providerMap.get(defaultApiProviderId)
  if (!defaultApiProvider || defaultApiProvider.kind !== 'api') {
    throw new Error('默认 API provider 必须是 API 类型')
  }

  validateProviderConnection(
    defaultApiProviderId,
    mergedConnections[defaultApiProviderId],
    current.providerConnections[defaultApiProviderId],
    Boolean(
      patch.defaultApiProviderId ||
      patch.providerConnections?.[defaultApiProviderId],
    ),
  )

  return patch as UpdateGlobalConfigRequest
}

function validateProviderConnection(
  providerId: string,
  connection: ProviderConnectionInput | undefined,
  current: ProviderConnectionInput | undefined,
  requireApiKey = false,
): void {
  if (!connection) {
    throw new Error(`缺少 ${providerId} 的连接配置`)
  }

  if (connection.baseUrl && !isValidUrl(connection.baseUrl)) {
    throw new Error(`${providerId} 的 base URL 无效`)
  }

  const extra = connection.extra ?? {}
  if (isAcpProviderId(providerId)) {
    if (extra.kind && extra.kind !== 'acp') {
      throw new Error(`${providerId} 的 extra.kind 必须是 acp`)
    }
    const connectionMode = extra.connectionMode
    if (connectionMode && connectionMode !== 'local' && connectionMode !== 'remote') {
      throw new Error(`${providerId} 的 connectionMode 只能是 local 或 remote`)
    }
    return
  }

  if (extra.kind && extra.kind !== 'api') {
    throw new Error(`${providerId} 的 extra.kind 必须是 api`)
  }

  const format = extra.apiFormat
  if (providerId === 'openai' && format && format !== 'openai') {
    throw new Error('openai provider 的 API 格式必须是 openai')
  }
  if (providerId === 'anthropic' && format && format !== 'anthropic') {
    throw new Error('anthropic provider 的 API 格式必须是 anthropic')
  }
  if (isCustomApiProviderId(providerId) && format !== 'openai' && format !== 'anthropic') {
    throw new Error(`${providerId} 的 API 格式必须是 openai 或 anthropic`)
  }

  if (!connection.baseUrl) {
    throw new Error(`${providerId} 必须配置 base URL`)
  }

  const model = typeof extra.model === 'string' ? extra.model.trim() : ''
  if (!model) {
    throw new Error(`${providerId} 必须配置 model`)
  }

  const hasApiKey =
    Boolean(connection.apiKey?.trim()) ||
    Boolean(current?.apiKeyMasked?.trim()) ||
    Boolean(current?.apiKey?.trim())
  if (requireApiKey && !hasApiKey) {
    throw new Error(`${providerId} 必须配置 API Key`)
  }
}

type ProviderConnectionInput = {
  providerId: string
  baseUrl?: string
  apiKey?: string
  apiKeyMasked?: string
  extra?: Record<string, unknown>
}

function isAcpProviderId(providerId: string): providerId is (typeof ACP_PROVIDER_IDS)[number] {
  return (ACP_PROVIDER_IDS as readonly string[]).includes(providerId)
}

function isBuiltinApiProviderId(providerId: string): providerId is (typeof BUILTIN_API_PROVIDER_IDS)[number] {
  return (BUILTIN_API_PROVIDER_IDS as readonly string[]).includes(providerId)
}

function isCustomApiProviderId(providerId: string): boolean {
  return providerId.startsWith(CUSTOM_API_PROVIDER_PREFIX) && providerId.length > CUSTOM_API_PROVIDER_PREFIX.length
}

function isApiProviderId(providerId: string): boolean {
  return isBuiltinApiProviderId(providerId) || isCustomApiProviderId(providerId)
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

async function validateAiApi(input: z.infer<typeof aiApiValidateSchema>): Promise<{ ok: boolean; message?: string; error?: string }> {
  const baseUrl = input.baseUrl.replace(/\/+$/, '')
  const apiKey = resolveAiApiKey(input.providerId, input.apiKey)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    if (input.format === 'anthropic') {
      const resp = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: controller.signal,
      })
      if (resp.ok) return { ok: true, message: 'Anthropic-compatible API 验证成功' }
      return { ok: false, error: await validationError(resp) }
    }

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    })
    if (resp.ok) return { ok: true, message: 'OpenAI-compatible API 验证成功' }
    return { ok: false, error: await validationError(resp) }
  } finally {
    clearTimeout(timeout)
  }
}

async function discoverAiApiModels(input: z.infer<typeof aiApiModelsDiscoverSchema>): Promise<AiApiModelsDiscoverResponse> {
  const baseUrl = input.baseUrl.replace(/\/+$/, '')
  const apiKey = resolveAiApiKey(input.providerId, input.apiKey)
  if (!apiKey) {
    return {
      ok: false,
      models: [],
      source: modelDiscoverySource(input.format),
      error: '请先配置 API Key',
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)

  try {
    const resp = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: buildModelDiscoveryHeaders(input.format, apiKey),
      signal: controller.signal,
    })

    if (!resp.ok) {
      return {
        ok: false,
        models: [],
        source: modelDiscoverySource(input.format),
        error: await validationError(resp),
      }
    }

    const payload = await resp.json().catch(() => ({}))
    const models = extractModelIds(payload)

    return {
      ok: true,
      models,
      source: modelDiscoverySource(input.format),
      ...(models.length === 0 ? { error: '模型接口未返回可识别的模型 ID' } : {}),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      models: [],
      source: modelDiscoverySource(input.format),
      error: message,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function buildModelDiscoveryHeaders(format: ApiFormat, apiKey: string): Record<string, string> {
  if (format === 'anthropic') {
    return {
      Accept: 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }
  }

  return {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

function modelDiscoverySource(format: ApiFormat): string {
  return format === 'anthropic' ? 'anthropic/models' : 'openai/models'
}

function resolveAiApiKey(providerId: string | undefined, apiKey: string | undefined): string {
  const direct = apiKey?.trim()
  if (direct) return direct
  if (!providerId) return ''

  const global = getGlobalConfigForRuntime()
  const provider = global.providers.find((item) => item.id === providerId)
  const connection = global.providerConnections[providerId]
  if (!provider || provider.kind !== 'api' || !connection) return ''
  return connection.apiKey?.trim() ?? ''
}

function extractModelIds(payload: unknown): string[] {
  const candidates: string[] = []

  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') candidates.push(item)
        if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
          candidates.push((item as { id: string }).id)
        }
      }
    }

    const models = (payload as { models?: unknown }).models
    if (Array.isArray(models)) {
      for (const item of models) {
        if (typeof item === 'string') candidates.push(item)
        if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
          candidates.push((item as { id: string }).id)
        }
      }
    }
  }

  return Array.from(new Set(candidates.filter((item) => item.trim().length > 0)))
}

async function validationError(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => '')
  if (resp.status === 401 || resp.status === 403) return `认证失败 (${resp.status})`
  if (resp.status === 404) return `接口路径不存在 (${resp.status})，请检查 base URL 是否包含 /v1`
  if (resp.status === 400) return `请求被拒绝 (${resp.status}): ${text.slice(0, 240)}`
  return `请求失败 (${resp.status}): ${text.slice(0, 240) || resp.statusText}`
}
