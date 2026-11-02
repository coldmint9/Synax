import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DATA_ROOT } from "../runtime/env.js";
import { logger } from "../runtime/logger.js";
import { isProviderSupported } from "./catalog-capabilities.js";
import { LLM_CATALOG_SNAPSHOT } from "./snapshot.js";
import { openAIModelContract } from "./openai-models.js";
import { withPublishedOutputLimits } from "./model-output-limits.js";
import type {
  ModelsDevProvider,
  RuntimeCatalog,
  RuntimeModel,
  RuntimeProvider,
} from "./types.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let memoryCache: { ts: number; catalog: RuntimeCatalog } | null = null;
let refreshPromise: Promise<RuntimeCatalog> | null = null;
let loadPromise: Promise<void> | null = null;
let workerReload: Promise<void> | null = null;
let workerReloadAt = 0;

function refreshWorkerCache(): void {
  if (workerReload || Date.now() < workerReloadAt) return;
  workerReloadAt = Date.now() + 1000;
  workerReload = readCacheFile().then(disk => {
    if (disk) memoryCache = disk;
  }).finally(() => { workerReload = null; });
}

function refreshCatalog(): Promise<RuntimeCatalog> {
  return refreshPromise ??= fetchRemoteCatalog()
    .then(async (catalog) => {
      const now = Date.now();
      memoryCache = { ts: now, catalog };
      await writeCacheFile(catalog, now);
      return catalog;
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err: message },
        "[llm-runtime] background catalog refresh failed",
      );
      return memoryCache!.catalog;
    })
    .finally(() => {
      refreshPromise = null;
    });
}

/** Load local metadata ahead of a turn; remote discovery never gates a send. */
export function warmupRuntimeCatalog(): void {
  void getRuntimeCatalog().catch(err => logger.warn({ err }, "[llm-runtime] catalog warm-up failed"));
}

export async function getRuntimeCatalog(
  forceRefresh = false,
): Promise<RuntimeCatalog> {
  if (!memoryCache) {
    await (loadPromise ??= (async () => {
      const disk = await readCacheFile();
      memoryCache = disk ?? { ts: 0, catalog: createCatalogFromProviders(LLM_CATALOG_SNAPSHOT, "snapshot") };
    })().finally(() => { loadPromise = null; }));
  }
  const cached = memoryCache!;
  if (forceRefresh) return refreshCatalog();
  if (process.env.SYNAX_AGENT_SESSION_CHILD === "1") {
    // The API host refreshes the shared catalog. Three warm workers must not
    // each download and parse another catalog while a user is sending.
    if (cached.catalog.source === "snapshot" || Date.now() - cached.ts >= CACHE_TTL_MS) refreshWorkerCache();
    return cached.catalog;
  }
  if (Date.now() - cached.ts >= CACHE_TTL_MS) {
    // Coalesce requests and back off after an offline refresh instead of
    // starting another network request on every model step.
    cached.ts = Date.now();
    void refreshCatalog();
  }
  return cached.catalog;
}

export async function getRuntimeProvider(
  providerId: string,
): Promise<RuntimeProvider | undefined> {
  const catalog = await getRuntimeCatalog();
  return catalog.providers.find((provider) => provider.id === providerId);
}

async function fetchRemoteCatalog(): Promise<RuntimeCatalog> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref();
  try {
    const resp = await fetch(MODELS_DEV_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`models.dev ${resp.status}`);
    }
    const body = (await resp.json()) as Record<string, ModelsDevProvider>;
    return createCatalogFromProviders(body, "remote");
  } finally {
    clearTimeout(timeout);
  }
}

function createCatalogFromProviders(
  payload: Record<string, ModelsDevProvider>,
  source: RuntimeCatalog["source"],
): RuntimeCatalog {
  const providers = Object.values(payload)
    .filter(
      (provider) =>
        provider &&
        typeof provider.id === "string" &&
        provider.models &&
        typeof provider.models === "object",
    )
    .map(toRuntimeProvider)
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    providers,
    fetchedAt: new Date().toISOString(),
    source,
  };
}

function toRuntimeProvider(provider: ModelsDevProvider): RuntimeProvider {
  const models = Object.values(provider.models ?? {})
    .map<RuntimeModel>((model) => withPublishedOutputLimits({
      id: model.id,
      inputModalities: model.modalities?.input
        ?.map((m) => (String(m) === "pdf" ? "file" : m))
        .filter(
          (m): m is import("../../modules/agent-runtime/content-parts.js").InputModality =>
            ["text", "image", "audio", "video", "file"].includes(m),
        ),
      label: model.name || model.id,
      maxTokens: model.limit?.output,
      contextLimit: model.limit?.context,
      inputLimit: model.limit?.input,
      toolCall: model.tool_call,
      reasoning: model.reasoning,
      outputModalities: model.modalities?.output,
      ...(provider.id === "openai" ? openAIModelContract(model.id) : {}),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  if (models.length > 0) {
    const defaultModel =
      models.find((model) => model.id === `${provider.id}-default`) ??
      models.find((model) => model.id.includes("mini")) ??
      models.find((model) => model.id.includes("flash")) ??
      models.find((model) => model.id.includes("sonnet")) ??
      models[0];
    if (defaultModel) defaultModel.isDefault = true;
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
  };
}

type CachedCatalogPayload = { savedAt: string; catalog: RuntimeCatalog };

function cacheFilePath(): string {
  const root = path.isAbsolute(DATA_ROOT)
    ? DATA_ROOT
    : path.resolve(process.cwd(), DATA_ROOT);
  return path.join(root, "llm-runtime", "models-dev-catalog.json");
}

async function readCacheFile(): Promise<{ ts: number; catalog: RuntimeCatalog } | null> {
  try {
    const file = cacheFilePath();
    const raw = JSON.parse(
      await fs.readFile(file, "utf8"),
    ) as CachedCatalogPayload;
    if (!Number.isFinite(Date.parse(raw?.savedAt)) || !Array.isArray(raw?.catalog?.providers)) return null;
    return {
      ts: Date.parse(raw.savedAt),
      catalog: {
        ...raw.catalog,
        source: "cache",
      },
    };
  } catch {
    return null;
  }
}

async function writeCacheFile(catalog: RuntimeCatalog, ts: number): Promise<void> {
  const file = cacheFilePath();
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      temporary,
      JSON.stringify(
        {
          savedAt: new Date(ts).toISOString(),
          catalog,
        } satisfies CachedCatalogPayload,
        null,
        2,
      ),
      "utf8",
    );
    await fs.rename(temporary, file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: message },
      "[llm-runtime] failed to persist catalog cache",
    );
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
