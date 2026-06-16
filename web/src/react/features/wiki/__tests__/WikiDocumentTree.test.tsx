import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import WikiDocumentTree from '../WikiDocumentTree'
import type { WikiDocument } from '../../../../lib/contracts/wiki'
import { useWikiStore } from '../../../state/wikiStore'

function makeDoc(partial: Partial<WikiDocument> & Pick<WikiDocument, 'id' | 'title'>): WikiDocument {
  return {
    snapshotId: 'snap-1',
    projectId: 'proj-1',
    docType: 'module',
    sortOrder: 0,
    parentId: null,
    contentMd: 'content',
    references: [],
    pipelineStage: 'done',
    manualState: 'none',
    staleState: 'fresh',
    isSection: false,
    createdAt: '',
    updatedAt: '',
    ...partial,
  }
}

describe('WikiDocumentTree', () => {
  beforeEach(() => {
    useWikiStore.setState({
      documents: [
        makeDoc({ id: 'sec', title: 'Core Modules', isSection: true, sortOrder: 1, createdAt: '2026-01-01T00:00:01Z' }),
        makeDoc({ id: 'mod-a', title: 'Module A', sortOrder: 1, createdAt: '2026-01-01T00:00:02Z' }),
        makeDoc({ id: 'mod-b', title: 'Module B', sortOrder: 2, createdAt: '2026-01-01T00:00:03Z' }),
      ],
      selectedDocumentId: 'mod-a',
      snapshot: null,
      draftsSummary: { ready: 0, generating: 0 },
      draftsById: {},
      goals: [],
    })
  })

  it('collapses and expands section folders on click', () => {
    render(<WikiDocumentTree />)

    expect(screen.getByText('Module A')).toBeInTheDocument()
    expect(screen.getByText('Module B')).toBeInTheDocument()

    const folder = screen.getByRole('button', { name: /core modules/i })
    expect(folder).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(folder)
    expect(folder).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Module A')).not.toBeInTheDocument()
    expect(screen.queryByText('Module B')).not.toBeInTheDocument()

    fireEvent.click(folder)
    expect(folder).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Module A')).toBeInTheDocument()
    expect(screen.getByText('Module B')).toBeInTheDocument()
  })

  it('shows a spinner on the document currently being generated', () => {
    render(<WikiDocumentTree generatingDocumentId="mod-b" />)

    const generatingRow = screen.getByRole('button', { name: /module b/i })
    expect(generatingRow).toHaveAttribute('aria-busy', 'true')
    expect(generatingRow.querySelector('.animate-spin')).toBeTruthy()
  })

  it('keeps collapse state after documents update', () => {
    const { rerender } = render(<WikiDocumentTree />)

    fireEvent.click(screen.getByRole('button', { name: /core modules/i }))
    expect(screen.queryByText('Module A')).not.toBeInTheDocument()

    useWikiStore.setState({
      documents: [
        makeDoc({ id: 'sec', title: 'Core Modules', isSection: true, sortOrder: 1, createdAt: '2026-01-01T00:00:01Z', updatedAt: '1' }),
        makeDoc({ id: 'mod-a', title: 'Module A', sortOrder: 1, createdAt: '2026-01-01T00:00:02Z', updatedAt: '1' }),
        makeDoc({ id: 'mod-b', title: 'Module B', sortOrder: 2, createdAt: '2026-01-01T00:00:03Z', updatedAt: '1' }),
      ],
    })

    rerender(<WikiDocumentTree />)
    expect(screen.getByRole('button', { name: /core modules/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Module A')).not.toBeInTheDocument()
  })
})
