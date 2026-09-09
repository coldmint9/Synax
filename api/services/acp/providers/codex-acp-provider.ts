// ---------------------------------------------------------------------------
// CodexAcpProvider - live provider backed by the `codex-acp` ACP adapter.
//
// OpenAI Codex CLI does not speak ACP natively. The official adapter
// `@agentclientprotocol/codex-acp` is a stdio ACP agent server that starts the
// Codex App Server (bundled @openai/codex) and translates ACP requests into
// Codex operations.
//
// Install: npm install -g @agentclientprotocol/codex-acp
// ---------------------------------------------------------------------------

import { resolveCodexSpawn } from '../protocol/acp-connection.js'
import type { AcpProvider } from '../registry/provider-registry.js'
import { createAcpAgentProvider } from './acp-agent-provider.js'

export const codexAcpProvider: AcpProvider = createAcpAgentProvider({
  id: 'codex-acp',
  label: 'Codex ACP',
  description: 'Codex Agent Client Protocol - codex-acp adapter wrapping local OpenAI Codex over JSON-RPC stdio',
  logTag: 'CodexAcp',
  processLabel: 'codex-acp',
  resolveSpawn: () => resolveCodexSpawn(),
})
