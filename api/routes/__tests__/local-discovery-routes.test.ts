import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectSettingsRoutes } from '../project-settings.js'
const mocks = vi.hoisted(() => ({ project: vi.fn(), discover: vi.fn(), importSkill: vi.fn() }))
vi.mock('../projects.js', () => ({ syncProjectBasics: vi.fn() }))
vi.mock('../../services/project-workspace.js', () => ({ readWorkspaceProject: mocks.project }))
vi.mock('../../services/integrations/local-discovery.js', () => ({ discoverLocalIntegrations: mocks.discover, importDiscoveredSkill: mocks.importSkill }))
function request(endpoint: string, body: unknown) {
  return projectSettingsRoutes.request(`/project-a/settings/integrations/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.project.mockReturnValue({ source: { localPath: '/project-a' } })
  mocks.discover.mockReturnValue({ mcp: { servers: [], unsupported: [] }, skills: [], locations: [], paths: new Map([['id', '/internal/path']]) })
  mocks.importSkill.mockReturnValue({ id: 'project/review', name: 'review' })
})
describe('local discovery routes', () => {
  it('scans the registered project and omits internal import path mappings', async () => {
    const response = await request('discovery', { directories: ['/extra'] })
    expect(response.status).toBe(200)
    expect(mocks.discover).toHaveBeenCalledWith('/project-a', { extraDirectories: ['/extra'] })
    expect(await response.json()).not.toHaveProperty('paths')
  })
  it('validates scan input and requires a registered local project', async () => {
    expect((await request('discovery', { directories: Array(9).fill('/extra') })).status).toBe(400)
    mocks.project.mockReturnValue(null)
    expect((await request('discovery', {})).status).toBe(404)
    expect(mocks.discover).not.toHaveBeenCalled()
  })
  it('imports by discovered id and reports conflicts without accepting arbitrary paths', async () => {
    expect((await request('skills/import', { id: '../anything' })).status).toBe(400)
    const id = 'a'.repeat(24)
    expect((await request('skills/import', { id })).status).toBe(201)
    expect(mocks.importSkill).toHaveBeenCalledWith('/project-a', id, { extraDirectories: [] })
    mocks.importSkill.mockImplementation(() => { throw new Error('Name conflict') })
    const response = await request('skills/import', { id })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Name conflict' })
  })
})
