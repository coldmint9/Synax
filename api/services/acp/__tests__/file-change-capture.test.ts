import { describe, expect, it } from 'vitest'
import { changesFromHints, diffLineStats, parseGitStatus, parseNumstat, summarizeChanges } from '../file-change-capture.js'

describe('file-change-capture', () => {
  it('parses git porcelain status', () => {
    const parsed = parseGitStatus([
      ' M web/src/a.ts',
      'A  web/src/b.ts',
      ' D web/src/c.ts',
      'R  web/src/old.ts -> web/src/new.ts',
      '?? web/src/new-file.ts',
    ].join('\n'))

    expect(parsed.get('web/src/a.ts')).toBe('modified')
    expect(parsed.get('web/src/b.ts')).toBe('added')
    expect(parsed.get('web/src/c.ts')).toBe('deleted')
    expect(parsed.get('web/src/new.ts')).toBe('renamed')
    expect(parsed.get('web/src/new-file.ts')).toBe('added')
  })

  it('parses numstat including binary dash values', () => {
    const parsed = parseNumstat([
      '12\t3\tweb/src/a.ts',
      '-\t-\tassets/logo.png',
    ].join('\n'))

    expect(parsed.get('web/src/a.ts')).toEqual({ additions: 12, deletions: 3 })
    expect(parsed.get('assets/logo.png')).toEqual({ additions: 0, deletions: 0 })
  })

  it('summarizes hint-only changes', () => {
    const changes = changesFromHints([{ path: './web/src/a.ts', startLine: 4 }, { path: 'web/src/a.ts' }])
    const result = summarizeChanges(changes)
    expect(result.fileChanges).toHaveLength(1)
    expect(result.fileChanges[0]).toMatchObject({ path: 'web/src/a.ts', changeType: 'unknown', source: 'acp_hint' })
    expect(result.changeSummary.files).toBe(1)
  })

  it('computes line stats for per-run content deltas', () => {
    expect(diffLineStats('a\nb\nc', 'a\nb2\nc\nd')).toEqual({ additions: 2, deletions: 1 })
    expect(diffLineStats('already dirty\nsame', 'already dirty\nsame')).toEqual({ additions: 0, deletions: 0 })
  })
})
