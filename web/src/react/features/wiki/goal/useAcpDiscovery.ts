import { useEffect, useState } from 'react'
import { configApi } from '../../../../lib/api/config'
import type { AcpDiscoveryItem } from '../../../../lib/contracts/config'

export function useAcpDiscovery(): AcpDiscoveryItem[] {
  const [acpDiscovery, setAcpDiscovery] = useState<AcpDiscoveryItem[]>([])

  useEffect(() => {
    void configApi.discoverAcp()
      .then(result => setAcpDiscovery(result.supported))
      .catch(() => {})
  }, [])

  return acpDiscovery
}
