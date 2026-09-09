import type { AcpDiscoveryItem } from '../../../../lib/contracts/config'

/**
 * ACP endpoints that were actually detected on this machine.
 *
 * Backend discovery returns every built-in ACP runtime; ones whose CLI/adapter
 * is not installed come back as `missing`. Those rows are hidden so the list
 * only shows runtimes that are present locally (`available` / `failed`).
 */
export function detectedAcpItems(items: AcpDiscoveryItem[]): AcpDiscoveryItem[] {
  return items.filter((item) => item.status !== 'missing')
}
