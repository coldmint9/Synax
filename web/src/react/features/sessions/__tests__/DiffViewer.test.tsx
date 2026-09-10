import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

const getSessionEnvironmentFile = vi.fn()
const highlightLines = vi.fn()

vi.mock('../../../../lib/api/agentRuntime', () => ({
  agentRuntimeApi: {
    getSessionEnvironmentFile: (...args: unknown[]) => getSessionEnvironmentFile(...args),
  },
}))

// The real highlighter loads a shiki grammar; the viewer only needs to know the
// per-line HTML it gets back, so stub it and assert on the injected markup.
vi.mock('../codeHighlight', () => ({
  highlightLines: (...args: unknown[]) => highlightLines(...args),
}))

const { DiffViewer } = await import('../DiffViewer')

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,5 @@',
  ' import { a } from "b"',
  '-const x = 1',
  '+const x = 2',
  '+const y = 3',
  ' ',
  ' export function f() {',
  '',
].join('\n')

function fileView(content: string) {
  return { sessionId: 'sess-1', path: 'src/app.ts', kind: 'diff', content, truncated: false }
}

async function renderViewer(path = 'src/app.ts') {
  const utils = render(<DiffViewer sessionId="sess-1" path={path} />)
  await act(async () => { await Promise.resolve() })
  return utils
}

describe('DiffViewer', () => {
  beforeEach(() => {
    getSessionEnvironmentFile.mockReset()
    highlightLines.mockReset()
    highlightLines.mockImplementation(async (code: string) =>
      code.split('\n').map(line => `<span class="tok">${line}</span>`))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('marks added and removed rows so the change reads at a glance', async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(PATCH))
    const { container } = await renderViewer()

    const added = container.querySelectorAll('.diff-row--add')
    const removed = container.querySelectorAll('.diff-row--del')
    const context = container.querySelectorAll('.diff-row--ctx')
    expect(added).toHaveLength(2)
    expect(removed).toHaveLength(1)
    expect(context).toHaveLength(3)

    // Line numbers still track both sides of the hunk.
    expect(added[0].querySelector('.diff-num--new')?.textContent).toBe('2')
    expect(added[0].querySelector('.diff-num--old')?.textContent).toBe('')
    expect(removed[0].querySelector('.diff-num--old')?.textContent).toBe('2')
    expect(removed[0].querySelector('.diff-marker')?.textContent).toBe('-')

    // Hunk header and header stats.
    expect(container.querySelector('.diff-band--hunk')?.textContent).toBe('@@ -1,4 +1,5 @@')
    expect(container.querySelector('.diff-stat--add')?.textContent).toBe('+2')
    expect(container.querySelector('.diff-stat--del')?.textContent).toBe('-1')
  })

  it('injects syntax-highlighted HTML into each changed row', async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(PATCH))
    const { container } = await renderViewer()

    await waitFor(() => {
      expect(container.querySelectorAll('.diff-text .tok').length).toBeGreaterThan(0)
    })
    const addedRow = container.querySelector('.diff-row--add')
    expect(addedRow?.querySelector('.tok')?.textContent).toBe('const x = 2')

    // Both sides of the hunk are highlighted, deleted rows included.
    const oldSide = 'import { a } from "b"\nconst x = 1\n\nexport function f() {'
    const newSide = 'import { a } from "b"\nconst x = 2\nconst y = 3\n\nexport function f() {'
    expect(highlightLines).toHaveBeenCalledWith(oldSide, 'src/app.ts')
    expect(highlightLines).toHaveBeenCalledWith(newSide, 'src/app.ts')
  })

  it('explains an empty diff instead of rendering a blank surface', async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(''))
    await renderViewer()

    expect(screen.getByText('该文件与 HEAD 相比没有差异')).toBeTruthy()
  })

  it('names both paths when the file was renamed', async () => {
    const renamed = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -1 +1 @@',
      '-const x = 1',
      '+const x = 2',
      '',
    ].join('\n')
    getSessionEnvironmentFile.mockResolvedValue(fileView(renamed))
    const { container } = await renderViewer()

    expect(container.querySelector('.diff-band--file')?.textContent).toBe('src/old.ts → src/new.ts')
  })

  it('does not claim a rename for an untracked file', async () => {
    const untracked = [
      'diff --git a/abs/new-file.ts b/abs/new-file.ts',
      'new file mode 100644',
      'index 0000000..f5e5bd3',
      '--- /dev/null',
      '+++ b/abs/new-file.ts',
      '@@ -0,0 +1,2 @@',
      '+export const a = 1',
      '+export const b = 2',
      '',
    ].join('\n')
    getSessionEnvironmentFile.mockResolvedValue(fileView(untracked))
    const { container } = await renderViewer()

    expect(container.querySelector('.diff-band--file')).toBeNull()
    expect(container.querySelectorAll('.diff-row--add')).toHaveLength(2)
  })

  it('surfaces read failures', async () => {
    getSessionEnvironmentFile.mockRejectedValue(new Error('boom'))
    await renderViewer()

    expect(screen.getByText('boom')).toBeTruthy()
  })

  it('falls back to raw text when the patch cannot be parsed', async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView('not a patch at all'))
    const { container } = await renderViewer()

    expect(container.querySelector('.diff-raw')?.textContent).toBe('not a patch at all')
  })
})
