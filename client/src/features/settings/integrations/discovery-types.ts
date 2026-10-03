import type { DiscoveredSkill } from '../../../adapters/transport/local-discovery'
import type { DiscoveredMcpServer } from '../../../shared/contracts/config'

export type DiscoveryItem =
  | {
      id: string
      name: string
      description: string
      kind: 'mcp'
      value: DiscoveredMcpServer
    }
  | {
      id: string
      name: string
      description: string
      kind: 'skill'
      value: DiscoveredSkill
    }
