import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  discoverLocalIntegrations,
  importDiscoveredSkill,
} from './local-discovery.js'
import { skillRegistry } from '../skills/skill-registry.js'

const state = vi.hoisted(() => ({ project: '' }))
vi.mock('../agent-runtime/tools/workspace.js', () => ({
  resolveProjectWorkDir: () => state.project,
}))
vi.mock('../skills/skill-source-service.js', () => ({
  skillSourceService: {
    ensureDefaultSources() {},
    listSources: () => [],
    getSource: () => null,
  },
}))
vi.mock('../skills/skill-install-service.js', () => ({
  skillInstallService: { listInstalls: () => [] },
}))
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
it('makes an imported local skill available to runtime listing and skill.load', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-skill-runtime-'))
  roots.push(root)
  const home = path.join(root, 'home')
  state.project = path.join(root, 'project')
  fs.mkdirSync(state.project)
  const directory = path.join(home, '.claude/skills/local-review')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'SKILL.md'),
    '---\nname: local-review\ndescription: Review local code\n---\nRead references/guide.md before reviewing.',
  )
  const options = { homeDir: home, env: {} }
  const discovered = discoverLocalIntegrations(state.project, options).skills[0]
  const imported = importDiscoveredSkill(state.project, discovered.id, options)
  const summary = skillRegistry
    .listSummaries({ projectId: 'project-test' })
    .find((s) => s.id === imported.id)
  expect(summary).toMatchObject({
    sourceKind: 'project',
    installed: true,
    name: 'local-review',
  })
  expect(
    skillRegistry.loadDetail({
      skillId: imported.id,
      projectId: 'project-test',
    }).content,
  ).toBe('Read references/guide.md before reviewing.')
})
