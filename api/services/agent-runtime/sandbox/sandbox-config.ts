import { agentRuntimeStore } from '../session-store.js';
import { isUnrestrictedPermissionRules } from '../permission-tiers.js';
import { workspaceRootHostPath, type ProjectWorkspaceRoot } from '../../project-workspace.js';

export interface SandboxConfig {
  blockedExtensions: Set<string>;
  resolveSymlinks: boolean;
  maxDepth: number;
  /** Unrestricted sessions release every remaining sandbox rule. */
  unrestricted: boolean;
  /** Explicit directory membership captured at run admission. */
  workspaceRoots?: string[];
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
  const config = defaultSandboxConfig();
  try {
    const session = agentRuntimeStore.tryGetSession(sessionId);
    if (session && isUnrestrictedPermissionRules(session.permissionRules)) {
      return unrestrictedSandboxConfig();
    }
    const binding = session?.sessionMetadata?.backend as { workspaceRoots?: ProjectWorkspaceRoot[] } | undefined;
    if (binding?.workspaceRoots) config.workspaceRoots = binding.workspaceRoots.map(workspaceRootHostPath);
  } catch {
    // Unavailable session state falls back to the restrictive default.
  }
  return config;
}

/** True when the session's effective rules release every sandbox rule. */
export function isUnrestrictedSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return sandboxConfigForSession(sessionId).unrestricted;
}
