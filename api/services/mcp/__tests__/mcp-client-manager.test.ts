import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

const originalEnv = {
  CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY,
  DATA_ROOT: process.env.DATA_ROOT,
}

let tempDir = ''
let manager: typeof import('../mcp-client-manager.js').mcpClientManager
let updateGlobalConfig: (patch: Record<string, unknown>, by: string) => void

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Synax-mcp-test-'))
  process.env.DATA_ROOT = tempDir
  process.env.CONFIG_ENCRYPTION_KEY = 'unit-test-mcp-secret'
  vi.resetModules()
  const configModule = await import('../../../lib/config/config-store.js')
  updateGlobalConfig = configModule.updateGlobalConfig as (patch: Record<string, unknown>, by: string) => void
  const managerModule = await import('../mcp-client-manager.js')
  manager = managerModule.mcpClientManager
})

afterEach(async () => {
  try {
    manager.closeAll()
  } catch { /* noop */ }
  vi.resetModules()
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  process.env.DATA_ROOT = originalEnv.DATA_ROOT
  process.env.CONFIG_ENCRYPTION_KEY = originalEnv.CONFIG_ENCRYPTION_KEY
})

const fixturePath = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))

describe('mcp client manager', () => {
  it('probes a stdio server and lists its tools', async () => {
    const result = await manager.probe({
      id: 'fixture',
      name: 'Fixture',
      command: process.execPath,
      args: [fixturePath],
    })
    expect(result.ok).toBe(true)
    expect(result.tools.map(t => t.name)).toContain('echo')
  }, 15000)

  it('warmup + callTool against a configured server', async () => {
    updateGlobalConfig({
      mcpServers: [
        {
          id: 'fixture',
          name: 'Fixture',
          command: process.execPath,
          args: [fixturePath],
          env: { MCP_FIXTURE: '1' },
        },
      ],
    }, 'tester')

    await manager.warmup(['fixture'])
    expect(manager.getCachedTools('fixture').map(t => t.name)).toContain('echo')

    const call = await manager.callTool('fixture', 'echo', { text: 'hello mcp' })
    expect(call.ok).toBe(true)
    expect(call.text).toContain('hello mcp')
  }, 20000)

  it('returns a failure when the server command does not exist', async () => {
    const result = await manager.probe({
      id: 'missing',
      name: 'Missing',
      command: '/definitely/not/a/real/bin/xyz',
      args: [],
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  }, 15000)
})
