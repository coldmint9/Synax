import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from '../../lib/env.js'
import { logger } from '../../lib/logger.js'
import { isProviderSupported } from './registry.js'
import { LLM_CATALOG_SNAPSHOT } from './snapshot.js'
import type { ModelsDevProvider, RuntimeCatalog, RuntimeModel, RuntimeProvider } from './types.js'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

let memoryCache: { ts: number; catalog: RuntimeCatalog } | null = null

export async function getRuntimeCatalog(forceRefresh = false): Promise<RuntimeCatalog> {
  const now = Date.now()
  if (!forceRefresh && memoryCache && now - memoryCache.ts < CACHE_TTL_MS) {
    return memoryCache.catalog
  }

  if (!forceRefresh) {
    const disk = readCacheFile()
    if (disk && now - disk.ts < CACHE_TTL_MS) {
      memoryCache = { ts: disk.ts, catalog: disk.catalog }
      return disk.catalog
    }
  }

  try {
    const remote = await fetchRemoteCatalog()
    memoryCache = { ts: now, catalog: remote }
    writeCacheFile(remote, now)
    return remote
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err: message }, '[llm-runtime] failed to refresh models.dev catalog')
    const disk = readCacheFile()
    if (disk) {
      memoryCache = { ts: disk.ts, catalog: disk.catalog }
      return disk.catalog
    }
    const snapshot = createCatalogFromProviders(LLM_CATALOG_SNAPSHOT, 'snapshot')
    memoryCache = { ts: now, catalog: snapshot }
    return snapshot
  }
}

export async function getRuntimeProvider(providerId: string): Promise<RuntimeProvider | undefined> {
  const catalog = await getRuntimeCatalog()
  return catalog.providers.find((provider) => provider.id === providerId)
}

async function fetchRemoteCatalog(): Promise<RuntimeCatalog> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const resp = await fetch(MODELS_DEV_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!resp.ok) {
      throw new Error(`models.dev ${resp.status}`)
    }
    const body = (await resp.json()) as Record<string, ModelsDevProvider>
    return createCatalogFromProviders(body, 'remote')
  } finally {
    clearTimeout(timeout)
  }
}

function createCatalogFromProviders(
  payload: Record<string, ModelsDevProvider>,
  source: RuntimeCatalog['source'],
): RuntimeCatalog {
  const providers = Object.values(payload)
    .filter((provider) => provider && typeof provider.id === 'string' && provider.models && typeof provider.models === 'object')
    .map(toRuntimeProvider)
    .sort((a, b) => a.label.localeCompare(b.label))

  return {
    providers,
    fetchedAt: new Date().toISOString(),
    source,
  }
}

function toRuntimeProvider(provider: ModelsDevProvider): RuntimeProvider {
  const models = Object.values(provider.models ?? {})
    .map<RuntimeModel>((model) => ({
      id: model.id,
      label: model.name || model.id,
      maxTokens: model.limit?.output,
      contextLimit: model.limit?.context,
      toolCall: model.tool_call,
      reasoning: model.reasoning,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  if (models.length > 0) {
    const defaultModel = models.find((model) => model.id === `${provider.id}-default`)
      ?? models.find((model) => model.id.includes('mini'))
      ?? models.find((model) => model.id.includes('flash'))
      ?? models.find((model) => model.id.includes('sonnet'))
      ?? models[0]
    if (defaultModel) defaultModel.isDefault = true
  }

  return {
    id: provider.id,
    label: provider.name || provider.id,
    description: provider.doc || provider.api,
    npm: provider.npm,
    api: provider.api,
    env: provider.env ?? [],
    doc: provider.doc,
    supported: isProviderSupported({ npm: provider.npm }),
    models,
  }
}

type CachedCatalogPayload = { savedAt: string; catalog: RuntimeCatalog }

function cacheFilePath(): string {
  const root = path.isAbsolute(DATA_ROOT) ? DATA_ROOT : path.resolve(process.cwd(), DATA_ROOT)
  const dir = path.join(root, 'llm-runtime')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'models-dev-catalog.json')
}

function readCacheFile(): { ts: number; catalog: RuntimeCatalog } | null {
  try {
    const file = cacheFilePath()
    if (!fs.existsSync(file)) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as CachedCatalogPayload
    if (!raw?.savedAt || !raw?.catalog) return null
    return {
      ts: Date.parse(raw.savedAt),
      catalog: {
        ...raw.catalog,
        source: 'cache',
      },
    }
  } catch {
    return null
  }
}

function writeCacheFile(catalog: RuntimeCatalog, ts: number): void {
  try {
    fs.writeFileSync(
      cacheFilePath(),
      JSON.stringify({ savedAt: new Date(ts).toISOString(), catalog } satisfies CachedCatalogPayload, null, 2),
      'utf8',
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err: message }, '[llm-runtime] failed to persist catalog cache')
  }
}
