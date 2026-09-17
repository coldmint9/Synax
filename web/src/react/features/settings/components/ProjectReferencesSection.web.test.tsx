import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectApi, type ProjectWorkspace } from '../../../../lib/api/project'
import { listRemoteDirectories } from '../../../../lib/api/fs'
import { ProjectReferencesSection } from './ProjectReferencesSection'

vi.mock('../../../../hooks/useLocale', () => ({
  useLocale: () => ({ locale: 'en' }),
}))

vi.mock('../../../../lib/api/project', () => ({
  projectApi: {
    getWorkspace: vi.fn(),
    listProjects: vi.fn(),
    addReference: vi.fn(),
    removeReference: vi.fn(),
  },
}))

// The browser build has no native dialog, so the header browse button must fall
// back to the runtime-host picker instead of being disabled.
vi.mock('../../../../lib/open-directory-picker', () => ({
  isElectron: false,
  openDirectoryPicker: vi.fn(),
}))

vi.mock('../../../../lib/api/fs', () => ({
  listRemoteDirectories: vi.fn(),
}))

function workspace(projectId: string): ProjectWorkspace {
  return {
    roots: [{ id: projectId, name: projectId, path: `/work/${projectId}`, role: 'primary', status: 'available' }],
  }
}

const pathInput = () => screen.getByRole('textbox', { name: 'Project directory path' })
const nameInput = () => screen.getByRole('textbox', { name: 'Project name (optional)' })

describe('ProjectReferencesSection in the browser build', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(projectApi.getWorkspace).mockResolvedValue(workspace('project-a'))
    vi.mocked(projectApi.listProjects).mockResolvedValue({ items: [], total: 0 })
    vi.mocked(listRemoteDirectories).mockResolvedValue({
      path: '/work/project-a',
      name: 'project-a',
      parent: '/',
      home: '/home/dev',
      shortcuts: [],
      entries: [{ name: 'shared', path: '/work/shared', hidden: false }],
      truncated: false,
    })
  })

  it('opens the host directory picker and fills the path from the selection', async () => {
    const user = userEvent.setup()
    render(<ProjectReferencesSection projectId="project-a" />)
    await screen.findByText('/work/project-a')
    await user.click(screen.getByRole('button', { name: 'Add project', exact: true }))

    const browse = screen.getByRole('button', { name: 'Browse' })
    expect(browse).toBeEnabled()
    await user.click(browse)

    const dialog = await screen.findByRole('dialog', { name: 'Choose project directory' })
    expect(dialog).toBeInTheDocument()
    // The picker seeds from the primary root when no path has been typed yet.
    expect(listRemoteDirectories).toHaveBeenCalledWith('/work/project-a', expect.anything())

    await user.click(screen.getByRole('button', { name: 'Choose this directory' }))

    expect(pathInput()).toHaveValue('/work/project-a')
    expect(nameInput()).toHaveValue('project-a')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('surfaces a picker listing failure inside the dialog', async () => {
    const user = userEvent.setup()
    vi.mocked(listRemoteDirectories).mockRejectedValueOnce(new Error('Directory is not readable: /root'))
    render(<ProjectReferencesSection projectId="project-a" />)
    await screen.findByText('/work/project-a')
    await user.click(screen.getByRole('button', { name: 'Add project', exact: true }))

    await user.click(screen.getByRole('button', { name: 'Browse' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Directory is not readable: /root')
    expect(pathInput()).toHaveValue('')
  })
})
