import { describe, expect, it } from 'vitest'
import type { AcpDiscoveryItem } from '../../../../../lib/contracts/config'
import { detectedAcpItems } from '../acpItems'

function item(id: string, status: AcpDiscoveryItem['status']): AcpDiscoveryItem {
  return {
    id,
    label: id,
    command: id,
    status,
    installed: status !== 'missing',
    handshakeOk: status === 'available',
    selected: false,
    compatibility: '',
  }
}

describe('detectedAcpItems', () => {
  it('hides missing (not installed) endpoints', () => {
    const items = [
      item('opencode-acp', 'available'),
      item('codex-acp', 'missing'),
      item('pi-acp', 'missing'),
      item('cursor-acp', 'failed'),
    ]
    expect(detectedAcpItems(items).map((i) => i.id)).toEqual(['opencode-acp', 'cursor-acp'])
  })

  it('returns empty array when nothing is detected', () => {
    expect(detectedAcpItems([item('codex-acp', 'missing')])).toEqual([])
  })
})
