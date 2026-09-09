// ---------------------------------------------------------------------------
// Canonical ACP provider ids.
//
// ACP providers are local agent runtimes that speak Agent Client Protocol over
// stdio (JSON-RPC). Native: opencode (`opencode acp`) and cursor
// (`cursor-agent acp`). Adapter-backed: codex (`codex-acp`) and pi (`pi-acp`).
//
// Keep this single list in sync with:
//   - api/lib/config/config-defaults.ts (BUILTIN_PROVIDERS)
//   - api/routes/acp.ts / api/routes/config.ts (route validation)
//   - api/services/acp/registry providers + spawn resolution
//   - web/src/lib/agents/contracts.ts / web/src/react/features/wiki/goal/goalModelOptions.ts
// ---------------------------------------------------------------------------

export const ACP_PROVIDER_IDS = [
  'opencode-acp',
  'cursor-acp',
  'codex-acp',
  'pi-acp',
] as const

export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number]

export function isAcpProviderId(providerId: string): providerId is AcpProviderId {
  return (ACP_PROVIDER_IDS as readonly string[]).includes(providerId)
}
