// ---------------------------------------------------------------------------
// PiAcpProvider - live provider backed by the `pi-acp` ACP adapter.
//
// pi (pi coding agent, @earendil-works/pi-coding-agent) does not speak ACP
// natively. `pi-acp` (e.g. @curxor/pi-acp) is a stdio ACP agent server that
// launches pi as a subprocess and translates between ACP and pi's RPC
// interface. pi itself must also be available on PATH.
//
// Install: npm install -g @curxor/pi-acp @earendil-works/pi-coding-agent
// ---------------------------------------------------------------------------

import { resolvePiSpawn } from '../protocol/acp-connection.js'
import type { AcpProvider } from '../registry/provider-registry.js'
import { createAcpAgentProvider } from './acp-agent-provider.js'

export const piAcpProvider: AcpProvider = createAcpAgentProvider({
  id: 'pi-acp',
  label: 'Pi ACP',
  description: 'Pi Agent Client Protocol - pi-acp adapter wrapping local pi coding agent over JSON-RPC stdio',
  logTag: 'PiAcp',
  processLabel: 'pi-acp',
  resolveSpawn: () => resolvePiSpawn(),
})
