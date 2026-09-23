import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SkillCard } from './SkillCard'
import type { SkillSummary } from '../../../lib/api/skills'
vi.mock('../../../hooks/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))
const skill: SkillSummary = {
  id: 'remote/test',
  name: 'test',
  label: 'Test skill',
  description: 'Example',
  sourceId: 'remote',
  sourceKind: 'remote',
  version: '',
  status: 'available',
  appliesTo: [],
  requiredCapabilities: [],
  permissionHints: [],
}
const handlers = { onInstall: vi.fn(), onUninstall: vi.fn(), onToggle: vi.fn() }
describe('SkillCard', () => {
  it('offers installation without a toggle or fake version before installing', () => {
    render(<SkillCard skill={skill} busy={false} {...handlers} />)
    expect(
      screen.getByRole('button', { name: 'skillMarketInstall' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByText('v0.0.0')).not.toBeInTheDocument()
  })
  it('shows real versions and enables disabled installations with a switch', async () => {
    render(
      <SkillCard
        skill={{
          ...skill,
          version: '2.1.0',
          installed: true,
          status: 'disabled',
          installationId: 'local/test',
        }}
        busy={false}
        {...handlers}
      />,
    )
    expect(screen.getByText('v2.1.0')).toBeInTheDocument()
    expect(screen.getByRole('switch')).not.toBeChecked()
    await userEvent.setup().click(screen.getByRole('switch'))
    expect(handlers.onToggle).toHaveBeenCalledWith(true)
  })
  it('does not offer uninstall for built-in or project-owned files', () => {
    render(
      <SkillCard
        skill={{ ...skill, sourceKind: 'builtin', installed: true }}
        busy={false}
        {...handlers}
      />,
    )
    expect(screen.getByRole('switch')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'extensionActions' }),
    ).not.toBeInTheDocument()
  })
})
