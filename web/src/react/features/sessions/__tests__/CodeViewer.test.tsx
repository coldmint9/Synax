import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

const getSessionEnvironmentFile = vi.fn()
const highlightCode = vi.fn()

vi.mock('../../../../lib/api/agentRuntime', () => ({
  agentRuntimeApi: {
    getSessionEnvironmentFile: (...args: unknown[]) => getSessionEnvironmentFile(...args),
  },
}))

vi.mock('../codeHighlight', () => ({
  highlightCode: (...args: unknown[]) => highlightCode(...args),
  languageForPath: (path: string) => (path.endsWith('.tsx') ? 'tsx' : 'typescript'),
}))

const { CodeViewer } = await import('../CodeViewer')

const SOURCE = 'const a = 1\nconst b = 2\n'

function fileView(content: string) {
  return { sessionId: 'sess-1', path: 'src/app.ts', kind: 'input', content, truncated: false }
}

async function renderViewer() {
  const utils = render(<CodeViewer sessionId="sess-1" path="src/app.ts" />)
  await act(async () => { await Promise.resolve() })
  return utils
}

describe('CodeViewer', () => {
  beforeEach(() => {
    getSessionEnvironmentFile.mockReset()
    highlightCode.mockReset()
    highlightCode.mockResolvedValue(
      '<pre class="shiki synax-code" style="color:var(--synax-code-foreground)">'
      + '<code><span class="line"><span style="color:var(--synax-code-token-keyword)">const</span> a = 1</span>'
      + '\n<span class="line">const b = 2</span></code></pre>',
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders the highlighted markup and a gutter that matches the file', async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(SOURCE))
    const { container } = await renderViewer()

    await waitFor(() => {
      expect(container.querySelector('.code-viewer-content .shiki')).not.toBeNull()
    })
    expect(highlightCode).toHaveBeenCalledWith(SOURCE, 'src/app.ts')
    expect(container.querySelector('.code-viewer-content .shiki span span')?.textContent).toBe('const')

    const numbers = container.querySelectorAll('.code-viewer-line-numbers > div')
    expect(Array.from(numbers, node => node.textContent)).toEqual(['1', '2', '3'])
    expect(container.querySelector('.code-viewer-gutter')).not.toBeNull()
  })

  it('shows the detected language in the header', async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(SOURCE))
    await renderViewer()

    expect(screen.getByText('typescript')).toBeTruthy()
  })

  it('surfaces read failures', async () => {
    getSessionEnvironmentFile.mockRejectedValue(new Error('missing file'))
    await renderViewer()

    expect(screen.getByText('missing file')).toBeTruthy()
  })
})
