import fs from 'node:fs'
import path from 'node:path'
import { getRawSqlite } from '../../db/index.js'
import { DATA_ROOT } from '../env.js'
import { logger } from '../logger.js'
import { BUILTIN_PROVIDERS, createDefaultGlobalConfig, createDefaultUserGlobalConfig } from './config-defaults.js'
import { decryptSecret, encryptSecret, isEncryptedSecret, maskSecret } from './config-secret.js'
import type {
  AnalyzerLlmConfig,
  EffectiveConfig,
  GlobalConfig,
  ProjectConfig,
  ProviderConnection,
  ProviderDef,
  ProviderModelDef,
  UpdateGlobalConfigRequest,
  UpdateProjectConfigRequest,
} from './config-types.js'

const GLOBAL_CONFIG_FILE = 'global-config.json'
const TEMPLATE_CONFIG_FILE = 'template-config.json'
const PROJECT_CONFIG_DIR = 'projects'
const MIGRATION_MARKER_FILE = '.json-source'
const CUSTOM_API_PROVIDER_PREFIX = 'custom-api:'
const TEMPLATE_PROVIDER_IDS = new Set(BUILTIN_PROVIDERS.map((provider) => provider.id))

let configStoreReady = false

type ConfigLayers = {
  template: GlobalConfig
  global: GlobalConfig
}

export function getGlobalConfig(): GlobalConfig {
  return getGlobalConfigInternal(false)
}

export function getGlobalConfigForRuntime(): GlobalConfig {
  return getGlobalConfigInternal(true)
}

function getGlobalConfigInternal(includeSecrets: boolean): GlobalConfig {
  ensureConfigStoreReady()
  const layers = loadConfigLayers(includeSecrets)
  return mergeGlobalConfigLayers(layers.template, layers.global, includeSecrets)
}

export function updateGlobalConfig(patch: UpdateGlobalConfigRequest, updatedBy: string): GlobalConfig {
  ensureConfigStoreReady()
  const now = new Date().toISOString()
  const layers = loadConfigLayers(true)
  const nextLayers = applyGlobalConfigPatch(layers, patch, updatedBy, now)

  writeJsonAtomic(templateConfigPath(), prepareGlobalConfigForStorage(nextLayers.template))
  writeJsonAtomic(globalConfigPath(), prepareGlobalConfigForStorage(nextLayers.global))
  writeMigrationMarker()
  return mergeGlobalConfigLayers(nextLayers.template, nextLayers.global, false)
}

export function getProjectConfig(projectId: string): ProjectConfig | null {
  return getProjectConfigInternal(projectId, false)
}

export function getProjectConfigForRuntime(projectId: string): ProjectConfig | null {
  return getProjectConfigInternal(projectId, true)
}

function getProjectConfigInternal(projectId: string, includeSecrets: boolean): ProjectConfig | null {
  ensureConfigStoreReady()
  const filePath = projectConfigPath(projectId)
  const stored = readJsonFile<ProjectConfig>(filePath)
  if (!stored) return null
  return normalizeProjectConfig(stored, includeSecrets)
}

export function upsertProjectConfig(
  projectId: string,
  patch: UpdateProjectConfigRequest,
  updatedBy: string,
): ProjectConfig {
  ensureConfigStoreReady()
  const existing = getProjectConfigInternal(projectId, true)
  const now = new Date().toISOString()
  const preparedPatch: UpdateProjectConfigRequest = { ...patch }

  if ('providerConnection' in patch) {
    preparedPatch.providerConnection = prepareProjectConnectionForStorage(
      patch.providerConnection,
      existing?.providerConnection,
    )
  }

  const merged: ProjectConfig = existing
    ? {
        ...existing,
        ...preparedPatch,
        version: existing.version + 1,
        updatedAt: now,
        updatedBy,
      }
    : {
        projectId,
        version: 1,
        providerId: preparedPatch.providerId,
        modelId: preparedPatch.modelId,
        providerConnection: preparedPatch.providerConnection,
        limits: preparedPatch.limits,
        custom: preparedPatch.custom,
        updatedAt: now,
        updatedBy,
      }

  const stored = prepareProjectConfigForStorage(merged)
  writeJsonAtomic(projectConfigPath(projectId), stored)
  return normalizeProjectConfig(stored, false)
}

export function deleteProjectConfig(projectId: string): boolean {
  ensureConfigStoreReady()
  const filePath = projectConfigPath(projectId)
  const backupPath = `${filePath}.bak`
  let deleted = false

  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true })
    deleted = true
  }
  if (fs.existsSync(backupPath)) {
    fs.rmSync(backupPath, { force: true })
    deleted = true || deleted
  }
  return deleted
}

export function getEffectiveConfig(projectId: string): EffectiveConfig {
  return getEffectiveConfigInternal(projectId, true)
}

export function getEffectiveConfigForDisplay(projectId: string): EffectiveConfig {
  return getEffectiveConfigInternal(projectId, false)
}

function getEffectiveConfigInternal(projectId: string, includeSecrets: boolean): EffectiveConfig {
  const global = getGlobalConfigInternal(includeSecrets)
  const project = getProjectConfigInternal(projectId, includeSecrets)

  const providerId = project?.providerId || global.defaultProviderId
  const provider = findProvider(global.providers, providerId)
  const modelId =
    project?.modelId ||
    provider?.models.find((model) => model.isDefault)?.id ||
    provider?.models[0]?.id ||
    `${providerId}-default`
  const model = findModel(provider, modelId)
  const globalConnection = global.providerConnections[providerId] ?? { providerId }
  const connection: ProviderConnection = project?.providerConnection
    ? {
        ...globalConnection,
        ...project.providerConnection,
        providerId,
        extra: {
          ...(globalConnection.extra ?? {}),
          ...(project.providerConnection.extra ?? {}),
        },
      }
    : globalConnection

  return {
    providerId,
    modelId,
    provider: provider ?? createFallbackProvider(providerId),
    model: model ?? { id: modelId, label: modelId, isDefault: true },
    connection,
    limits: {
      ...global.limits,
      ...(project?.limits ?? {}),
    },
  }
}

export function listAvailableProviders(): ProviderDef[] {
  return getGlobalConfig().providers.filter((provider) => provider.status !== 'inactive')
}

export function getProviderDetail(providerId: string): ProviderDef | undefined {
  return getGlobalConfig().providers.find((provider) => provider.id === providerId)
}

export function getAnalyzerLlmConfig(includeSecrets = true): AnalyzerLlmConfig | null {
  const global = getGlobalConfigInternal(includeSecrets)
  const provider = global.providers.find((item) => item.id === global.defaultApiProviderId)
  const connection = global.providerConnections[global.defaultApiProviderId]
  if (!provider || provider.kind !== 'api' || !connection) return null

  const apiFormat = resolveApiFormat(global.defaultApiProviderId, connection)
  const model =
    typeof connection.extra?.model === 'string' && connection.extra.model.trim()
      ? connection.extra.model.trim()
      : provider.models.find((item) => item.isDefault)?.id ?? provider.models[0]?.id ?? ''

  return {
    providerId: global.defaultApiProviderId,
    apiFormat,
    baseUrl: connection.baseUrl ?? defaultBaseUrl(apiFormat),
    ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
    ...(connection.apiKeyMasked ? { apiKeyMasked: connection.apiKeyMasked } : {}),
    model,
  }
}

function ensureConfigStoreReady(): void {
  if (configStoreReady) return
  ensureDirectory(configRoot())
  ensureDirectory(projectConfigDir())

  const markerExists = fs.existsSync(migrationMarkerPath())
  const templateExists = fs.existsSync(templateConfigPath())
  const globalExists = fs.existsSync(globalConfigPath())

  if (!markerExists) {
    if (!templateExists && globalExists) {
      migrateLegacyJsonConfigIfNeeded()
    } else {
      const migrated = migrateLegacyConfigIfNeeded()
      if (!migrated) {
        if (!templateExists) {
          writeJsonAtomic(templateConfigPath(), prepareGlobalConfigForStorage(createDefaultGlobalConfig()), { preserveBackup: false })
        }
        if (!globalExists) {
          writeJsonAtomic(globalConfigPath(), prepareGlobalConfigForStorage(createDefaultUserGlobalConfig()), { preserveBackup: false })
        }
      }
    }
    writeMigrationMarker()
  } else {
    if (!templateExists) {
      writeJsonAtomic(templateConfigPath(), prepareGlobalConfigForStorage(createDefaultGlobalConfig()), { preserveBackup: false })
    }
    if (!globalExists) {
      writeJsonAtomic(globalConfigPath(), prepareGlobalConfigForStorage(createDefaultUserGlobalConfig()), { preserveBackup: false })
    }
  }

  configStoreReady = true
}

function migrateLegacyJsonConfigIfNeeded(): boolean {
  const stored = readGlobalConfigFile()
  if (!stored) return false
  const split = splitMergedGlobalConfig(stored)
  writeJsonAtomic(templateConfigPath(), prepareGlobalConfigForStorage(split.template), { preserveBackup: false })
  writeJsonAtomic(globalConfigPath(), prepareGlobalConfigForStorage(split.global), { preserveBackup: false })
  return true
}

function migrateLegacyConfigIfNeeded(): boolean {
  const db = getRawSqlite()
  const globalRow = db.prepare('SELECT config_json, version, updated_at, updated_by FROM global_config WHERE id = 1').get() as
    | { config_json: string; version: number; updated_at: string; updated_by: string }
    | undefined
  const projectRows = db.prepare('SELECT project_id, config_json, version, updated_at, updated_by FROM project_config').all() as Array<{
    project_id: string
    config_json: string
    version: number
    updated_at: string
    updated_by: string
  }>

  if (!globalRow && projectRows.length === 0) return false

  const legacyGlobal = globalRow
    ? (JSON.parse(globalRow.config_json) as GlobalConfig)
    : createDefaultGlobalConfig()
  const split = splitMergedGlobalConfig(legacyGlobal)

  writeJsonAtomic(templateConfigPath(), prepareGlobalConfigForStorage(split.template), { preserveBackup: false })
  writeJsonAtomic(globalConfigPath(), prepareGlobalConfigForStorage(split.global), { preserveBackup: false })

  for (const row of projectRows) {
    const parsed = JSON.parse(row.config_json) as ProjectConfig
    const projectConfig: ProjectConfig = {
      ...parsed,
      projectId: row.project_id,
      version: row.version,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }
    writeJsonAtomic(projectConfigPath(row.project_id), prepareProjectConfigForStorage(projectConfig), { preserveBackup: false })
  }

  try {
    db.prepare('DELETE FROM global_config').run()
    db.prepare('DELETE FROM project_config').run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err: message }, '[config] legacy config cleanup failed')
    throw err
  }

  logger.info({ projects: projectRows.length }, '[config] legacy sqlite config migrated to json')
  return true
}

function loadConfigLayers(includeSecrets: boolean): ConfigLayers {
  const template = readTemplateConfigFile() ?? createDefaultGlobalConfig()
  const global = readGlobalConfigFile() ?? createDefaultUserGlobalConfig()
  return {
    template: normalizeTemplateConfig(template, includeSecrets),
    global: normalizeUserGlobalConfig(global, includeSecrets),
  }
}

function readTemplateConfigFile(): GlobalConfig | null {
  return readJsonFile<GlobalConfig>(templateConfigPath())
}

function readGlobalConfigFile(): GlobalConfig | null {
  return readJsonFile<GlobalConfig>(globalConfigPath())
}

function splitMergedGlobalConfig(config: GlobalConfig): ConfigLayers {
  const templateBase = createDefaultGlobalConfig(config.updatedBy ?? 'system')
  const globalBase = createDefaultUserGlobalConfig(config.updatedBy ?? 'system')

  const templateProviders = (config.providers ?? [])
    .filter((provider) => isTemplateProviderId(provider.id))
    .map(normalizeProviderDef)
  const userProviders = (config.providers ?? [])
    .filter((provider) => !isTemplateProviderId(provider.id))
    .map(normalizeProviderDef)

  const templateConnections: Record<string, ProviderConnection> = {}
  const userConnections: Record<string, ProviderConnection> = {}
  for (const [providerId, connection] of Object.entries(config.providerConnections ?? {})) {
    if (isTemplateProviderId(providerId)) {
      templateConnections[providerId] = connection
    } else {
      userConnections[providerId] = connection
    }
  }

  return {
    template: {
      ...templateBase,
      version: config.version,
      providers: mergeProviderDefs(templateBase.providers, templateProviders),
      providerConnections: mergeProviderConnections(templateBase.providerConnections, templateConnections, true, templateBase.providers),
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy,
    },
    global: {
      ...globalBase,
      version: config.version,
      providers: userProviders,
      providerConnections: normalizeConnections(userConnections, true),
      defaultProviderId: normalizeAcpProviderId(config.defaultProviderId),
      defaultApiProviderId: config.defaultApiProviderId || globalBase.defaultApiProviderId,
      enabledAcpProviderIds: config.enabledAcpProviderIds ?? globalBase.enabledAcpProviderIds,
      limits: config.limits,
      features: config.features,
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy,
    },
  }
}

function normalizeMergedGlobalConfig(config: GlobalConfig, includeSecrets: boolean): GlobalConfig {
  const split = splitMergedGlobalConfig(config)
  return mergeGlobalConfigLayers(split.template, split.global, includeSecrets)
}

function normalizeTemplateConfig(config: GlobalConfig, includeSecrets: boolean): GlobalConfig {
  const defaults = createDefaultGlobalConfig(config.updatedBy ?? 'system')
  const incomingProviders = (config.providers ?? []).filter((provider) => isTemplateProviderId(provider.id))
  const providers = mergeProviderDefs(defaults.providers, incomingProviders)
  const incomingConnections = pickConnections(config.providerConnections ?? {}, TEMPLATE_PROVIDER_IDS)
  const providerConnections = mergeProviderConnections(defaults.providerConnections, incomingConnections, includeSecrets)
  return {
    ...defaults,
    ...config,
    providers,
    providerConnections,
    defaultProviderId: normalizeAcpProviderId(config.defaultProviderId),
    defaultApiProviderId: normalizeApiProviderId(config.defaultApiProviderId, providers),
    enabledAcpProviderIds: config.enabledAcpProviderIds ?? defaults.enabledAcpProviderIds,
  }
}

function normalizeUserGlobalConfig(config: GlobalConfig, includeSecrets: boolean): GlobalConfig {
  const defaults = createDefaultUserGlobalConfig(config.updatedBy ?? 'system')
  const incomingProviders = (config.providers ?? []).filter((provider) => !isTemplateProviderId(provider.id))
  const providers = normalizeProviders(incomingProviders)
  const incomingConnections = pickConnections(config.providerConnections ?? {}, providers.map((provider) => provider.id))
  const providerConnections = normalizeConnections(incomingConnections, includeSecrets)
  return {
    ...defaults,
    ...config,
    providers,
    providerConnections,
    defaultProviderId: normalizeAcpProviderId(config.defaultProviderId),
    defaultApiProviderId: config.defaultApiProviderId || defaults.defaultApiProviderId,
    enabledAcpProviderIds: config.enabledAcpProviderIds ?? defaults.enabledAcpProviderIds,
  }
}

function mergeGlobalConfigLayers(template: GlobalConfig, global: GlobalConfig, includeSecrets: boolean): GlobalConfig {
  const providers = mergeProviderDefs(template.providers, global.providers)
  const providerConnections = mergeProviderConnections(template.providerConnections, global.providerConnections, includeSecrets, providers)
  const latest = pickLatestMetadata(template, global)
  return {
    version: Math.max(template.version ?? 1, global.version ?? 1),
    providers,
    defaultProviderId: normalizeAcpProviderId(global.defaultProviderId ?? template.defaultProviderId),
    defaultApiProviderId: normalizeApiProviderId(global.defaultApiProviderId ?? template.defaultApiProviderId, providers),
    enabledAcpProviderIds: global.enabledAcpProviderIds ?? template.enabledAcpProviderIds,
    providerConnections,
    limits: global.limits ?? template.limits,
    features: global.features ?? template.features,
    updatedAt: latest.updatedAt,
    updatedBy: latest.updatedBy,
  }
}

function applyGlobalConfigPatch(
  layers: ConfigLayers,
  patch: UpdateGlobalConfigRequest,
  updatedBy: string,
  updatedAt: string,
): ConfigLayers {
  const current = mergeGlobalConfigLayers(layers.template, layers.global, true)
  const templatePatchProviders = patch.providers?.filter((provider) => isTemplateProviderId(provider.id))
  const userPatchProviders = patch.providers?.filter((provider) => !isTemplateProviderId(provider.id))
  const templatePatchConnections = pickConnections(patch.providerConnections ?? {}, TEMPLATE_PROVIDER_IDS)
  const userProviderIds = new Set(
    (userPatchProviders?.length ? userPatchProviders : layers.global.providers).map((provider) => provider.id),
  )
  const userPatchConnections = pickConnections(patch.providerConnections ?? {}, userProviderIds)

  const nextTemplateProviders = templatePatchProviders
    ? mergeProviderDefs(layers.template.providers, templatePatchProviders)
    : layers.template.providers
  const nextTemplateConnections =
    templatePatchProviders || Object.keys(templatePatchConnections).length > 0
      ? mergeProviderConnections(layers.template.providerConnections, templatePatchConnections, true, nextTemplateProviders)
      : layers.template.providerConnections

  const nextGlobalProviders = userPatchProviders ? normalizeProviders(userPatchProviders) : layers.global.providers
  const nextGlobalConnections =
    userPatchProviders || Object.keys(userPatchConnections).length > 0
      ? mergeProviderConnections(layers.global.providerConnections, userPatchConnections, true, nextGlobalProviders)
      : layers.global.providerConnections

  const globalTouched =
    Boolean(patch.defaultProviderId) ||
    Boolean(patch.defaultApiProviderId) ||
    Boolean(patch.enabledAcpProviderIds) ||
    Boolean(patch.limits) ||
    Boolean(patch.features) ||
    Boolean(userPatchProviders?.length) ||
    Object.keys(userPatchConnections).length > 0
  const templateTouched = Boolean(templatePatchProviders?.length) || Object.keys(templatePatchConnections).length > 0

  const nextTemplate: GlobalConfig = {
    ...layers.template,
    providers: nextTemplateProviders,
    providerConnections: nextTemplateConnections,
    updatedAt: templateTouched ? updatedAt : layers.template.updatedAt,
    updatedBy: templateTouched ? updatedBy : layers.template.updatedBy,
    version: templateTouched ? layers.template.version + 1 : layers.template.version,
  }

  const allProviders = mergeProviderDefs(nextTemplateProviders, nextGlobalProviders)
  const allConnections = { ...nextTemplateConnections, ...nextGlobalConnections }
  const resolvedDefaultApiProviderId = patch.defaultApiProviderId
    ?? autoSelectDefaultApiProvider(allProviders, allConnections)
    ?? current.defaultApiProviderId

  const nextGlobal: GlobalConfig = {
    ...layers.global,
    providers: nextGlobalProviders,
    providerConnections: nextGlobalConnections,
    defaultProviderId: normalizeAcpProviderId(patch.defaultProviderId ?? current.defaultProviderId),
    defaultApiProviderId: resolvedDefaultApiProviderId,
    enabledAcpProviderIds: patch.enabledAcpProviderIds ?? current.enabledAcpProviderIds,
    limits: patch.limits ? { ...current.limits, ...patch.limits } : current.limits,
    features: patch.features ? { ...current.features, ...patch.features } : current.features,
    updatedAt: globalTouched ? updatedAt : layers.global.updatedAt,
    updatedBy: globalTouched ? updatedBy : layers.global.updatedBy,
    version: globalTouched ? layers.global.version + 1 : layers.global.version,
  }

  return { template: nextTemplate, global: nextGlobal }
}

function normalizeProjectConfig(config: ProjectConfig, includeSecrets: boolean): ProjectConfig {
  return {
    ...config,
    providerConnection: config.providerConnection
      ? normalizeProviderConnection(config.providerConnection, includeSecrets)
      : config.providerConnection,
  }
}

function normalizeProviders(providers: ProviderDef[]): ProviderDef[] {
  const map = new Map<string, ProviderDef>()
  for (const provider of providers) {
    if (!isKnownProviderId(provider.id)) continue
    if (isTemplateProviderId(provider.id)) continue
    map.set(provider.id, normalizeProviderDef(provider))
  }
  return Array.from(map.values())
}

function normalizeProviderDef(provider: ProviderDef): ProviderDef {
  return {
    ...provider,
    kind: isApiProviderId(provider.id) ? 'api' : 'acp',
    status: provider.status === 'inactive' ? 'inactive' : provider.status === 'experimental' ? 'experimental' : 'live',
    models: Array.isArray(provider.models) ? provider.models : [],
  }
}

function isTemplateProviderId(providerId: string): boolean {
  return TEMPLATE_PROVIDER_IDS.has(providerId)
}

function mergeProviderDefs(existing: ProviderDef[], incoming: ProviderDef[]): ProviderDef[] {
  const map = new Map<string, ProviderDef>()
  for (const provider of existing) {
    map.set(provider.id, normalizeProviderDef(provider))
  }
  for (const provider of incoming) {
    if (!isKnownProviderId(provider.id)) continue
    map.set(provider.id, normalizeProviderDef(provider))
  }
  return Array.from(map.values())
}

function preserveApiKey(connection: ProviderConnection, existing?: ProviderConnection): ProviderConnection {
  if (connection.apiKey) return connection
  if (!existing?.apiKey) return connection
  if (connection.apiKeyMasked || !('apiKey' in connection)) {
    return { ...connection, apiKey: existing.apiKey, apiKeyMasked: existing.apiKeyMasked }
  }
  return connection
}

function mergeProviderConnections(
  existing: Record<string, ProviderConnection>,
  incoming: Record<string, ProviderConnection>,
  includeSecrets: boolean,
  providers?: ProviderDef[],
): Record<string, ProviderConnection> {
  const allowedIds = providers
    ? new Set(providers.map((provider) => provider.id))
    : new Set<string>([...Object.keys(existing), ...Object.keys(incoming)])
  const result: Record<string, ProviderConnection> = {}

  const merged = { ...existing, ...incoming }
  for (const [providerId, connection] of Object.entries(merged)) {
    if (!allowedIds.has(providerId)) continue
    const prev = existing[providerId]
    const preserved = preserveApiKey(connection, prev)
    result[providerId] = normalizeProviderConnection(preserved, includeSecrets)
  }

  return result
}

function normalizeConnections(
  connections: Record<string, ProviderConnection>,
  includeSecrets: boolean,
): Record<string, ProviderConnection> {
  const result: Record<string, ProviderConnection> = {}
  for (const [providerId, connection] of Object.entries(connections)) {
    result[providerId] = normalizeProviderConnection(connection, includeSecrets)
  }
  return result
}

function pickConnections(
  connections: Record<string, ProviderConnection>,
  allowedIds: Iterable<string>,
): Record<string, ProviderConnection> {
  const allowed = new Set(allowedIds)
  const result: Record<string, ProviderConnection> = {}
  for (const [providerId, connection] of Object.entries(connections)) {
    if (!allowed.has(providerId)) continue
    result[providerId] = connection
  }
  return result
}

function pickLatestMetadata(
  left: Pick<GlobalConfig, 'updatedAt' | 'updatedBy'>,
  right: Pick<GlobalConfig, 'updatedAt' | 'updatedBy'>,
): Pick<GlobalConfig, 'updatedAt' | 'updatedBy'> {
  return right.updatedAt >= left.updatedAt
    ? { updatedAt: right.updatedAt, updatedBy: right.updatedBy }
    : { updatedAt: left.updatedAt, updatedBy: left.updatedBy }
}

function normalizeProviderConnection(connection: ProviderConnection, includeSecrets: boolean): ProviderConnection {
  const apiKey = includeSecrets ? decryptSecret(connection.apiKey) : undefined
  const apiKeyMasked = connection.apiKeyMasked ?? (includeSecrets || !isEncryptedSecret(connection.apiKey) ? maskSecret(connection.apiKey) : '****')
  return {
    ...connection,
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyMasked ? { apiKeyMasked } : {}),
    ...(!includeSecrets ? { apiKey: undefined } : {}),
  }
}

function prepareGlobalConfigForStorage(config: GlobalConfig): GlobalConfig {
  return {
    ...config,
    providerConnections: prepareProviderConnectionsForStorage(config.providerConnections),
  }
}

function prepareProjectConfigForStorage(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    providerConnection: config.providerConnection
      ? prepareProviderConnectionForStorage(config.providerConnection, undefined)
      : config.providerConnection,
  }
}

function prepareProviderConnectionsForStorage(connections: Record<string, ProviderConnection>): Record<string, ProviderConnection> {
  return Object.fromEntries(
    Object.entries(connections).map(([providerId, connection]) => [
      providerId,
      prepareProviderConnectionForStorage(connection, undefined),
    ]),
  )
}

function prepareProjectConnectionForStorage(
  patch: ProviderConnection | null | undefined,
  current: ProviderConnection | null | undefined,
): ProviderConnection | null | undefined {
  if (patch === null || patch === undefined) return patch
  return prepareProviderConnectionForStorage(patch, current ?? undefined)
}

function prepareProviderConnectionForStorage(
  patch: ProviderConnection,
  current: ProviderConnection | undefined,
): ProviderConnection {
  if (!('apiKey' in patch) && current?.apiKey) {
    return {
      ...patch,
      apiKey: encryptSecret(current.apiKey),
      apiKeyMasked: maskSecret(current.apiKey),
    }
  }

  if (patch.apiKeyMasked && !patch.apiKey) {
    return {
      ...patch,
      apiKey: current?.apiKey ? encryptSecret(current.apiKey) : undefined,
      apiKeyMasked: current?.apiKey ? maskSecret(current.apiKey) : patch.apiKeyMasked,
    }
  }

  const encrypted = encryptSecret(patch.apiKey)
  return {
    ...patch,
    ...(encrypted ? { apiKey: encrypted, apiKeyMasked: maskSecret(patch.apiKey) } : { apiKey: undefined, apiKeyMasked: undefined }),
  }
}

function normalizeAcpProviderId(providerId?: string | null): string {
  return providerId === 'cursor-acp' || providerId === 'opencode-acp' ? providerId : 'opencode-acp'
}

function autoSelectDefaultApiProvider(
  providers: ProviderDef[],
  connections: Record<string, ProviderConnection>,
): string | null {
  const configured = providers.filter(
    (p) => p.kind === 'api' && p.status !== 'inactive' && connections[p.id]?.apiKey,
  )
  return configured.length === 1 ? configured[0].id : null
}

function normalizeApiProviderId(providerId?: string | null, providers: ProviderDef[] = BUILTIN_PROVIDERS): string {
  const resolved = providers.find((provider) => provider.kind === 'api' && provider.id === providerId)
  if (resolved) return resolved.id
  const fallback = providers.find((provider) => provider.kind === 'api')
  return fallback?.id ?? 'openai'
}

function isAcpProviderId(providerId: string): providerId is 'opencode-acp' | 'cursor-acp' {
  return providerId === 'opencode-acp' || providerId === 'cursor-acp'
}

function isBuiltinApiProviderId(providerId: string): providerId is 'openai' | 'anthropic' {
  return providerId === 'openai' || providerId === 'anthropic'
}

function isCustomApiProviderId(providerId: string): boolean {
  return providerId.startsWith(CUSTOM_API_PROVIDER_PREFIX) && providerId.length > CUSTOM_API_PROVIDER_PREFIX.length
}

function isApiProviderId(providerId: string): boolean {
  return isBuiltinApiProviderId(providerId) || isCustomApiProviderId(providerId)
}

function isKnownProviderId(providerId: string): boolean {
  return isAcpProviderId(providerId) || isApiProviderId(providerId)
}

function resolveApiFormat(providerId: string, connection: ProviderConnection): 'openai' | 'anthropic' {
  const format = connection.extra?.apiFormat
  if (format === 'anthropic') return 'anthropic'
  if (format === 'openai') return 'openai'
  return providerId === 'anthropic' ? 'anthropic' : 'openai'
}

function defaultBaseUrl(format: 'openai' | 'anthropic'): string {
  return format === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'
}

function findProvider(providers: ProviderDef[], id: string): ProviderDef | undefined {
  return providers.find((provider) => provider.id === id)
}

function findModel(provider: ProviderDef | undefined, modelId: string): ProviderModelDef | undefined {
  if (!provider) return undefined
  return provider.models.find((model) => model.id === modelId)
}

function createFallbackProvider(id: string): ProviderDef {
  return {
    id,
    label: id,
    status: 'inactive',
    kind: isApiProviderId(id) ? 'api' : 'acp',
    caps: { canFollowUp: false, canCancel: false },
    models: [{ id: `${id}-default`, label: `${id} Default`, isDefault: true }],
  }
}

function ensureDirectory(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function isJsonFileValid(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false
    JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return true
  } catch {
    return false
  }
}

function readJsonFile<T>(filePath: string): T | null {
  const backupPath = `${filePath}.bak`

  if (!fs.existsSync(filePath)) {
    if (fs.existsSync(backupPath) && isJsonFileValid(backupPath)) {
      const parsed = JSON.parse(fs.readFileSync(backupPath, 'utf8')) as T
      writeJsonAtomic(filePath, parsed, { preserveBackup: false })
      logger.warn({ filePath }, '[config] restored missing json file from backup')
      return parsed
    }
    return null
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (err) {
    if (fs.existsSync(backupPath) && isJsonFileValid(backupPath)) {
      const parsed = JSON.parse(fs.readFileSync(backupPath, 'utf8')) as T
      writeJsonAtomic(filePath, parsed, { preserveBackup: false })
      logger.warn({ filePath }, '[config] repaired json file from backup')
      return parsed
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ filePath, err: message }, '[config] failed to read json file')
    throw err
  }
}

function writeJsonAtomic(
  filePath: string,
  data: unknown,
  options?: { preserveBackup?: boolean },
): void {
  ensureDirectory(path.dirname(filePath))
  const preserveBackup = options?.preserveBackup !== false
  const backupPath = `${filePath}.bak`

  if (preserveBackup && fs.existsSync(filePath) && isJsonFileValid(filePath)) {
    fs.copyFileSync(filePath, backupPath)
  }

  const tmpPath = `${filePath}.tmp`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true })
    } catch {
      /* noop */
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ filePath, err: message }, '[config] failed to write json file')
    throw err
  }
}

function writeMigrationMarker(): void {
  const marker = {
    source: 'json',
    updatedAt: new Date().toISOString(),
  }
  writeJsonAtomic(migrationMarkerPath(), marker, { preserveBackup: false })
}

function globalConfigPath(): string {
  return path.join(configRoot(), GLOBAL_CONFIG_FILE)
}

function templateConfigPath(): string {
  return path.join(configRoot(), TEMPLATE_CONFIG_FILE)
}

function migrationMarkerPath(): string {
  return path.join(configRoot(), MIGRATION_MARKER_FILE)
}

function projectConfigDir(): string {
  return path.join(configRoot(), PROJECT_CONFIG_DIR)
}

function projectConfigPath(projectId: string): string {
  return path.join(projectConfigDir(), `${encodeURIComponent(projectId)}.json`)
}

function configRoot(): string {
  return path.join(resolveDataRoot(), 'config')
}

function resolveDataRoot(): string {
  return path.isAbsolute(DATA_ROOT) ? DATA_ROOT : path.resolve(process.cwd(), DATA_ROOT)
}
