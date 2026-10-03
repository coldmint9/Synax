// ---------------------------------------------------------------------------
// CursorAcpProvider - live provider backed by `cursor-agent acp` CLI.
//
// Cursor's ACP entrypoint is the `cursor-agent` (a.k.a. `agent`) CLI, which is
// probed asynchronously because it can live under several names/paths.
// ---------------------------------------------------------------------------

import { CURSOR_CLI_INSTALL_HINT, resolveCursorCliBinary } from '../cursor-cli-resolve.js'
import { buildCursorSpawnSpec } from '../protocol/acp-connection.js'
import type { AcpProvider } from '../registry/provider-registry.js'
import { createAcpAgentProvider } from './acp-agent-provider.js'

export const cursorAcpProvider: AcpProvider = createAcpAgentProvider({
  id: 'cursor-acp',
  label: 'Cursor ACP',
  description: 'Cursor 官方 Agent，通过本地 cursor-agent CLI 以 JSON-RPC over stdio 通信（@agentclientprotocol/sdk）',
  logTag: 'CursorAcp',
  processLabel: 'cursor-agent',
  async resolveSpawn() {
    const cli = await resolveCursorCliBinary()
    if (!cli) throw new Error(CURSOR_CLI_INSTALL_HINT)
    return buildCursorSpawnSpec(cli)
  },
})
