import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from '../env.js'
import { logger } from '../logger.js'
import type { ProjectConfig, ProviderConnection } from './config-types.js'
import { encryptSecret, decryptSecret, maskSecret, isEncryptedSecret } from './config-secret.js'
import type {
  ProjectSettings,
  ProjectSettingsSection,
  UpdateProjectSettingsRequest,
  HighRiskAuthEnvelope,
} from './project-settings-types.js'
import { createDefaultProjectSettings } from './project-settings-types.js'

const PROJECT_SETTINGS_DIR = 'project-settings'

function settingsRoot(): string {
  const dataRoot = path.isAbsolute(DATA_ROOT) ? DATA_ROOT : path.resolve(process.cwd(), DATA_ROOT)
  return path.join(dataRoot, PROJECT_SETTINGS_DIR)
}

function settingsPath(projectId: string): string {
  return path.join(settingsRoot(), `${encodeURIComponent(projectId)}.json`)
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ filePath, err: msg }, '[project-settings] failed to read json')
    return null
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, filePath)
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }) } catch { /* noop */ }
    throw err
  }
}

function normalizeConnection(conn: ProviderConnection | null | undefined, includeSecrets: boolean): ProviderConnection | null | undefined {
  if (!conn) return conn
  const apiKey = includeSecrets ? decryptSecret(conn.apiKey) : undefined
  const apiKeyMasked = conn.apiKeyMasked ?? maskSecret(conn.apiKey)
  return {
    ...conn,
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyMasked ? { apiKeyMasked } : {}),
    ...(!includeSecrets ? { apiKey: undefined } : {}),
  }
}

function prepareConnectionForStorage(conn: ProviderConnection | null | undefined): ProviderConnection | null | undefined {
  if (!conn) return conn
  const encrypted = encryptSecret(conn.apiKey)
  return {
    ...conn,
    ...(encrypted ? { apiKey: encrypted, apiKeyMasked: maskSecret(conn.apiKey) } : { apiKey: undefined, apiKeyMasked: undefined }),
  }
}

function migrateFromLegacyProjectConfig(projectId: string): ProjectSettings | null {
  const dataRoot = path.isAbsolute(DATA_ROOT) ? DATA_ROOT : path.resolve(process.cwd(), DATA_ROOT)
  const legacyPath = path.join(dataRoot, 'config', 'projects', `${encodeURIComponent(projectId)}.json`)
  const legacy = readJson<ProjectConfig>(legacyPath)
  if (!legacy) return null

  const settings = createDefaultProjectSettings(projectId, legacy.updatedBy ?? 'system')
  settings.version = legacy.version
  settings.provider = {
    providerId: legacy.providerId,
    modelId: legacy.modelId,
    providerConnection: legacy.providerConnection,
    limits: legacy.limits,
  }
  settings.updatedAt = legacy.updatedAt
  settings.updatedBy = legacy.updatedBy

  logger.info({ projectId }, '[project-settings] migrated from legacy project config')
  return settings
}

export function getProjectSettings(projectId: string, includeSecrets = false): ProjectSettings {
  ensureDir(settingsRoot())
  const filePath = settingsPath(projectId)
  let settings = readJson<ProjectSettings>(filePath)

  if (!settings) {
    settings = migrateFromLegacyProjectConfig(projectId)
    if (settings) {
      writeJsonAtomic(filePath, prepareSettingsForStorage(settings))
    } else {
      settings = createDefaultProjectSettings(projectId)
    }
  }

  return normalizeSettings(settings, includeSecrets)
}

export function updateProjectSettings(
  projectId: string,
  patch: UpdateProjectSettingsRequest,
  updatedBy: string,
): ProjectSettings {
  const existing = getProjectSettings(projectId, true)
  const now = new Date().toISOString()

  const updated: ProjectSettings = {
    ...existing,
    basics: patch.basics ? { ...existing.basics, ...patch.basics } : existing.basics,
    provider: patch.provider ? mergeProvider(existing.provider, patch.provider) : existing.provider,
    collaboration: patch.collaboration
      ? { ...existing.collaboration, ...patch.collaboration, reviewPolicy: patch.collaboration.reviewPolicy ?? existing.collaboration.reviewPolicy }
      : existing.collaboration,
    notifications: patch.notifications ? { ...existing.notifications, ...patch.notifications } : existing.notifications,
    compliance: patch.compliance ? { ...existing.compliance, ...patch.compliance } : existing.compliance,
    version: existing.version + 1,
    updatedAt: now,
    updatedBy,
  }

  writeJsonAtomic(settingsPath(projectId), prepareSettingsForStorage(updated))
  return normalizeSettings(updated, false)
}

export function patchProjectSettingsSection(
  projectId: string,
  section: ProjectSettingsSection,
  data: unknown,
  updatedBy: string,
): ProjectSettings {
  const patch: UpdateProjectSettingsRequest = { [section]: data }
  return updateProjectSettings(projectId, patch, updatedBy)
}

export function deleteProjectSettings(projectId: string): boolean {
  const filePath = settingsPath(projectId)
  if (!fs.existsSync(filePath)) return false
  fs.rmSync(filePath, { force: true })
  return true
}

export function archiveProject(projectId: string, _auth: HighRiskAuthEnvelope, updatedBy: string): ProjectSettings {
  const existing = getProjectSettings(projectId, true)
  existing.lifecycleState = 'archived'
  existing.version += 1
  existing.updatedAt = new Date().toISOString()
  existing.updatedBy = updatedBy
  writeJsonAtomic(settingsPath(projectId), prepareSettingsForStorage(existing))
  return normalizeSettings(existing, false)
}

export function restoreProject(projectId: string, _auth: HighRiskAuthEnvelope, updatedBy: string): ProjectSettings {
  const existing = getProjectSettings(projectId, true)
  existing.lifecycleState = 'active'
  existing.version += 1
  existing.updatedAt = new Date().toISOString()
  existing.updatedBy = updatedBy
  writeJsonAtomic(settingsPath(projectId), prepareSettingsForStorage(existing))
  return normalizeSettings(existing, false)
}

export function transferProject(projectId: string, newOwnerMemberId: string, _auth: HighRiskAuthEnvelope, updatedBy: string): ProjectSettings {
  const existing = getProjectSettings(projectId, true)
  existing.basics.ownerMemberId = newOwnerMemberId
  existing.version += 1
  existing.updatedAt = new Date().toISOString()
  existing.updatedBy = updatedBy
  writeJsonAtomic(settingsPath(projectId), prepareSettingsForStorage(existing))
  return normalizeSettings(existing, false)
}

function mergeProvider(existing: ProjectSettings['provider'], patch: Partial<ProjectSettings['provider']>): ProjectSettings['provider'] {
  return {
    ...existing,
    ...patch,
    limits: patch.limits !== undefined ? (patch.limits ? { ...existing.limits, ...patch.limits } : undefined) : existing.limits,
  }
}

function normalizeSettings(settings: ProjectSettings, includeSecrets: boolean): ProjectSettings {
  return {
    ...settings,
    provider: {
      ...settings.provider,
      providerConnection: normalizeConnection(settings.provider.providerConnection, includeSecrets) as ProviderConnection | null | undefined,
    },
  }
}

function prepareSettingsForStorage(settings: ProjectSettings): ProjectSettings {
  return {
    ...settings,
    provider: {
      ...settings.provider,
      providerConnection: prepareConnectionForStorage(settings.provider.providerConnection) as ProviderConnection | null | undefined,
    },
  }
}
