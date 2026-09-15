import { agentRuntimeStore } from '../session-store.js';
import { isUnrestrictedPermissionRules } from '../permission-tiers.js';

export interface SandboxConfig {
  blockedExtensions: Set<string>;
  resolveSymlinks: boolean;
  maxDepth: number;
  /** Unrestricted sessions release every remaining sandbox rule. */
  unrestricted: boolean;
}

export function defaultSandboxConfig(): SandboxConfig {
  return {
    blockedExtensions: new Set(['.key', '.pem', '.p12', '.pfx']),
    resolveSymlinks: true,
    maxDepth: 30,
    unrestricted: false,
  };
}

/** Unrestricted sessions bypass the workspace boundary, extensions and depth. */
export function unrestrictedSandboxConfig(): SandboxConfig {
  return {
    blockedExtensions: new Set(),
    resolveSymlinks: true,
    maxDepth: Number.POSITIVE_INFINITY,
    unrestricted: true,
  };
}

/**
 * Config for a session. Unrestricted sessions release all sandbox rules;
 * every other session (and any unknown/missing session) keeps the default.
 */
export function sandboxConfigForSession(sessionId: string): SandboxConfig {
  try {
    const session = agentRuntimeStore.tryGetSession(sessionId);
    if (session && isUnrestrictedPermissionRules(session.permissionRules)) {
      return unrestrictedSandboxConfig();
    }
  } catch {
    // Unavailable session state falls back to the restrictive default.
  }
  return defaultSandboxConfig();
}

/** True when the session's effective rules release every sandbox rule. */
export function isUnrestrictedSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return sandboxConfigForSession(sessionId).unrestricted;
}
