// ---------------------------------------------------------------------------
// OpenCodeAcpProvider - live provider backed by `opencode acp` CLI.
// ---------------------------------------------------------------------------

import { resolveOpenCodeSpawn } from '../protocol/acp-connection.js'
import type { AcpProvider } from '../registry/provider-registry.js'
import { createAcpAgentProvider } from './acp-agent-provider.js'

export const openCodeAcpProvider: AcpProvider = createAcpAgentProvider({
  id: 'opencode-acp',
  label: 'OpenCode ACP',
  description: 'OpenCode Agent Client Protocol - local opencode CLI over JSON-RPC stdio',
  logTag: 'OpenCodeAcp',
  processLabel: 'opencode',
  resolveSpawn: () => resolveOpenCodeSpawn(),
})
