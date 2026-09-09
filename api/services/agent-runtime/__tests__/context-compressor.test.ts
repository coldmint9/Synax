import { describe, expect, it } from 'vitest'
import { getCompactionConfig, shouldCompact } from '../context-compressor.js'

describe('context compaction threshold', () => {
  it('does not compact below the default 200K window at 150K tokens', () => {
    expect(shouldCompact(150_000, 200_000, getCompactionConfig())).toBe(false)
  })

  it('compacts above the default 200K window', () => {
    expect(shouldCompact(200_001, 200_000, getCompactionConfig())).toBe(true)
  })

  it('defers compaction for a 1M input-context model well past 200K', () => {
    // 1M-context model (threshold 0.92) should not compact at 300K tokens…
    expect(shouldCompact(300_000, 1_000_000, getCompactionConfig())).toBe(false)
    // …and only compact once total tokens exceed 920K.
    expect(shouldCompact(921_000, 1_000_000, getCompactionConfig())).toBe(true)
  })

  it('respects disabled compaction', () => {
    expect(shouldCompact(5_000_000, 1_000_000, getCompactionConfig({ enabled: false }))).toBe(false)
  })
})
