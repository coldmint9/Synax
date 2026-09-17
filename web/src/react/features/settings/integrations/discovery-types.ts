import type { DiscoveredSkill } from '../../../../lib/api/local-discovery'
import type { DiscoveredMcpServer } from '../../../../lib/contracts/config'

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
