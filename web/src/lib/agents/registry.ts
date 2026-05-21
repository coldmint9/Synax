// ---------------------------------------------------------------------------
// web/src/lib/agents/registry.ts — Agent Provider 注册表（配置驱动版）
//
// 优先级：
//   1. 从 API /api/config/global 获取 ACP provider 列表
//   2. 回退到内置静态列表（网络不可用时）
//
// 迁移说明：旧的硬编码 providers 列表已移至 api/lib/config/config-defaults.ts
// ---------------------------------------------------------------------------

import type { AgentProvider, CursorAgentAdapter, ProviderId } from './contracts'
import { CursorAcpApiAdapter } from './adapters/cursor-acp-api-adapter'
import { configApi } from '../api/config'
import type { ProviderDef } from '../contracts/config'

/** 静态回退列表（API 不可用时使用） */
const STATIC_FALLBACK: AgentProvider[] = [
  {
    id: 'opencode-acp',
    label: 'OpenCode ACP',
    status: 'live',
    caps: { canFollowUp: true, canCancel: true },
  },
  {
    id: 'cursor-acp',
    label: 'Cursor ACP',
    status: 'live',
    caps: { canFollowUp: true, canCancel: true },
  },
]

const adapters: Record<string, CursorAgentAdapter> = {
  'opencode-acp': new CursorAcpApiAdapter('opencode-acp'),
  'cursor-acp': new CursorAcpApiAdapter('cursor-acp'),
}

// ── 缓存 ──────────────────────────────────────────────────────────────────

let _cachedProviders: AgentProvider[] | null = null
let _cacheTs = 0
const CACHE_TTL_MS = 30_000 // 30 秒

function convertToAgentProvider(p: ProviderDef): AgentProvider {
  return {
    id: p.id as ProviderId,
    label: p.label,
    status: p.status === 'inactive' ? 'live' : p.status as AgentProvider['status'],
    caps: p.caps,
  }
}

// ── 公共 API ──────────────────────────────────────────────────────────────

export async function listProviders(): Promise<AgentProvider[]> {
  const now = Date.now()
  if (_cachedProviders && now - _cacheTs < CACHE_TTL_MS) {
    return _cachedProviders
  }

  try {
    const resp = await configApi.getGlobal()
    const converted = resp.config.providers
      .filter((p) => p.kind === 'acp' && p.status !== 'inactive')
      .map(convertToAgentProvider)
    _cachedProviders = converted
    _cacheTs = now
    return converted
  } catch {
    console.warn('[agent/registry] config API unavailable, using static fallback')
    return STATIC_FALLBACK
  }
}

/** 同步版本（使用缓存，过期时回退静态列表） */
export function listProvidersSync(): AgentProvider[] {
  if (_cachedProviders && Date.now() - _cacheTs < CACHE_TTL_MS) {
    return _cachedProviders
  }
  return STATIC_FALLBACK
}

export function getAdapter(providerId: string): CursorAgentAdapter {
  const adapter = adapters[providerId]
  if (!adapter) {
    console.warn(`[agent/registry] unknown provider '${providerId}', falling back to opencode-acp`)
    return adapters['opencode-acp']!
  }
  return adapter
}

/** 注册新的 adapter（扩展用） */
export function registerAdapter(providerId: string, adapter: CursorAgentAdapter): void {
  adapters[providerId] = adapter
}

/** 刷新缓存（下次 listProviders 会重新请求） */
export function invalidateProviderCache(): void {
  _cachedProviders = null
  _cacheTs = 0
}
