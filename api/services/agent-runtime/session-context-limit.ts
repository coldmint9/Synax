import type { AgentSession } from './contracts.js';
import { profileService } from './profile-service.js';
import { resolveGatewaySelection } from '../llm-runtime/gateway.js';
import { resolveSessionEngineModel } from './acp-engine/acp-engine-routing.js';
import { isAcpModel } from './acp-engine/acp-model.js';
import { logger } from '../../lib/logger.js';

/**
 * Provider-configured context window for a session's effective model.
 *
 * The usage bar renders `contextLimit` from session stats. That must follow the
 * provider configuration (Settings → provider → model → context window, e.g.
 * the 1M toggle) instead of whatever window the provider reports in its usage
 * payload. Sessions running on an external ACP engine report their own window,
 * so they are left untouched.
 */

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { key: string; at: number; value: number | null }>();

export function resetSessionContextLimitCacheForTests(): void {
  cache.clear();
}

export async function resolveSessionConfiguredContextLimit(
  session: AgentSession,
): Promise<number | null> {
  const engineModel = resolveSessionEngineModel(session.id, {});
  if (isAcpModel(engineModel)) return null;

  const profile = profileService.tryGet(session.profileId);
  const key = [session.projectId, engineModel ?? '', profile.kind].join('|');
  const cached = cache.get(session.id);
  if (cached && cached.key === key && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  let value: number | null = null;
  try {
    const selection = await resolveGatewaySelection({
      projectId: session.projectId,
      purpose: profile.kind,
      model: engineModel ?? undefined,
    });
    const limit = selection.modelDef.contextLimit;
    value = typeof limit === 'number' && limit > 0 ? limit : null;
  } catch (err) {
    logger.debug(
      { sessionId: session.id, err: err instanceof Error ? err.message : String(err) },
      '[session-context-limit] provider window unavailable',
    );
    value = null;
  }

  cache.set(session.id, { key, at: Date.now(), value });
  return value;
}
