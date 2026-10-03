import { describe, expect, it } from 'vitest'
import { changesFromHints, diffLineStats, parseGitStatus, parseNumstat, summarizeChanges } from '../file-change-capture.js'

describe('file-change-capture', () => {
  it('parses git porcelain status', () => {
    const parsed = parseGitStatus([
      ' M client/src/a.ts',
      'A  client/src/b.ts',
      ' D client/src/c.ts',
      'R  client/src/old.ts -> client/src/new.ts',
      '?? client/src/new-file.ts',
    ].join('\n'))

    expect(parsed.get('client/src/a.ts')).toBe('modified')
    expect(parsed.get('client/src/b.ts')).toBe('added')
    expect(parsed.get('client/src/c.ts')).toBe('deleted')
    expect(parsed.get('client/src/new.ts')).toBe('renamed')
    expect(parsed.get('client/src/new-file.ts')).toBe('added')
  })

  it('parses numstat including binary dash values', () => {
    const parsed = parseNumstat([
      '12\t3\tclient/src/a.ts',
      '-\t-\tassets/logo.png',
    ].join('\n'))

    expect(parsed.get('client/src/a.ts')).toEqual({ additions: 12, deletions: 3 })
    expect(parsed.get('assets/logo.png')).toEqual({ additions: 0, deletions: 0 })
  })

  it('summarizes hint-only changes', () => {
    const changes = changesFromHints([{ path: './client/src/a.ts', startLine: 4 }, { path: 'client/src/a.ts' }])
    const result = summarizeChanges(changes)
    expect(result.fileChanges).toHaveLength(1)
    expect(result.fileChanges[0]).toMatchObject({ path: 'client/src/a.ts', changeType: 'unknown', source: 'acp_hint' })
    expect(result.changeSummary.files).toBe(1)
  })

  it('computes line stats for per-run content deltas', () => {
    expect(diffLineStats('a\nb\nc', 'a\nb2\nc\nd')).toEqual({ additions: 2, deletions: 1 })
    expect(diffLineStats('already dirty\nsame', 'already dirty\nsame')).toEqual({ additions: 0, deletions: 0 })
  })
})
