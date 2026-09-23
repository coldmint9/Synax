import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverLocalIntegrations,
  importDiscoveredSkill,
} from './local-discovery.js'

const temporary: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-integrations-'))
  temporary.push(root)
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  fs.mkdirSync(home)
  fs.mkdirSync(project)
  return {
    home,
    project,
    options: { homeDir: home, env: {}, platform: 'linux' as const },
  }
}
function write(file: string, value: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}
const skill = (name: string) =>
  `---\nname: ${name}\ndescription: >-\n  Review source code\n  and report defects.\n---\nRead the source before making changes.`
afterEach(() => {
  for (const root of temporary.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

describe('local integration discovery', () => {
  it('finds Claude, Codex, shared symlinks, project skills and plugin caches with provenance', () => {
    const { home, project, options } = fixture()
    write(path.join(home, '.claude/skills/review/SKILL.md'), skill('review'))
    write(
      path.join(home, '.codex/skills/.system/create/SKILL.md'),
      skill('create'),
    )
    write(
      path.join(
        home,
        '.codex/plugins/cache/market/plugin/1.0/skills/design/SKILL.md',
      ),
      skill('design'),
    )
    write(path.join(project, '.agents/skills/build/SKILL.md'), skill('build'))
    fs.mkdirSync(path.join(home, '.agents/skills'), { recursive: true })
    fs.symlinkSync(
      path.join(home, '.claude/skills/review'),
      path.join(home, '.agents/skills/review'),
    )
    const result = discoverLocalIntegrations(project, options)
    expect(result.skills.map((s) => s.name)).toEqual([
      'build',
      'create',
      'design',
      'review',
    ])
    expect(result.skills.find((s) => s.name === 'review')).toMatchObject({
      description: 'Review source code and report defects.',
      sources: [
        expect.objectContaining({ client: 'Claude Code' }),
        expect.objectContaining({ client: 'Agents' }),
      ],
    })
    expect(
      result.skills.find((s) => s.name === 'build')?.sources[0].scope,
    ).toBe('project')
    expect(
      result.locations.some((location) => location.status === 'missing'),
    ).toBe(true)
  })
  it('respects configured tool homes and Codex explicit skill paths', () => {
    const { home, project, options } = fixture()
    const codexHome = path.join(home, 'custom-codex')
    const claudeHome = path.join(home, 'custom-claude')
    write(
      path.join(codexHome, 'config.toml'),
      '[mcp_servers.docs]\ncommand = "docs-mcp"\nenabled = false\n[[skills.config]]\npath = "../extra/SKILL.md"\n',
    )
    write(path.join(home, 'extra/SKILL.md'), skill('extra'))
    write(
      path.join(claudeHome, '.claude.json'),
      '{"mcpServers":{"claude":{"command":"claude-mcp"}}}',
    )
    const result = discoverLocalIntegrations(project, {
      ...options,
      env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome },
    })
    expect(result.skills.map((s) => s.name)).toEqual(['extra'])
    expect(result.mcp.servers.map((s) => s.server.name)).toEqual([
      'claude',
      'docs',
    ])
    expect(
      result.mcp.servers.find((s) => s.server.name === 'docs')?.server.enabled,
    ).toBe(false)
  })
  it('isolates broken files, reports unsupported servers, and scans custom directories', () => {
    const { home, project, options } = fixture()
    write(path.join(home, '.claude/skills/broken/SKILL.md'), 'No description')
    write(
      path.join(project, '.mcp.json'),
      '{"mcpServers":{"remote":{"url":"https://example.test/mcp"},"legacy":{"type":"sse","url":"https://example.test/sse"}}}',
    )
    const custom = path.join(home, 'custom')
    write(path.join(custom, 'SKILL.md'), skill('custom'))
    write(
      path.join(custom, 'mcp.json'),
      '{"mcpServers":{"custom":{"command":"custom-mcp"}}}',
    )
    const result = discoverLocalIntegrations(project, {
      ...options,
      extraDirectories: [custom],
    })
    expect(result.skills.map((s) => s.name)).toEqual(['custom'])
    expect(result.mcp.servers.map((s) => s.server.name)).toEqual(['custom', 'remote'])
    expect(result.mcp.servers[0].server.cwd).toBe(custom)
    expect(result.mcp.unsupported[0].name).toBe('legacy')
    expect(result.locations.filter((s) => s.status === 'error')).toHaveLength(1)
  })
  it('copies the complete skill and prevents overwrites or arbitrary path imports', () => {
    const { home, project, options } = fixture()
    write(path.join(home, '.claude/skills/review/SKILL.md'), skill('review'))
    write(
      path.join(home, '.claude/skills/review/scripts/run.sh'),
      '#!/bin/sh\necho review',
    )
    write(path.join(home, '.claude/skills/review/references/guide.md'), 'Guide')
    const discovered = discoverLocalIntegrations(project, options).skills[0]
    expect(importDiscoveredSkill(project, discovered.id, options)).toEqual({
      id: 'project/review',
      name: 'review',
    })
    expect(
      fs.readFileSync(
        path.join(project, '.synax/skills/review/scripts/run.sh'),
        'utf8',
      ),
    ).toContain('echo review')
    expect(
      fs.readFileSync(
        path.join(project, '.synax/skills/review/references/guide.md'),
        'utf8',
      ),
    ).toBe('Guide')
    expect(
      discoverLocalIntegrations(project, options).skills[0].installed,
    ).toBe(true)
    expect(() =>
      importDiscoveredSkill(project, discovered.id, options),
    ).toThrow('already exists')
    expect(() =>
      importDiscoveredSkill(project, '../../etc/passwd', options),
    ).toThrow('no longer available')
    write(
      path.join(project, '.synax/skills/review/SKILL.md'),
      skill('review') + '\nEdited',
    )
    expect(discoverLocalIntegrations(project, options).skills[0]).toMatchObject(
      { installed: false, conflict: true },
    )
  })
  it('rejects escaping package symlinks without leaving a partial install', () => {
    const { home, project, options } = fixture()
    write(path.join(home, '.claude/skills/review/SKILL.md'), skill('review'))
    write(path.join(home, 'outside.txt'), 'private')
    fs.symlinkSync(
      path.join(home, 'outside.txt'),
      path.join(home, '.claude/skills/review/secret'),
    )
    const discovered = discoverLocalIntegrations(project, options).skills[0]
    expect(() =>
      importDiscoveredSkill(project, discovered.id, options),
    ).toThrow('outside its package')
    expect(fs.existsSync(path.join(project, '.synax/skills/review'))).toBe(
      false,
    )
  })
})
