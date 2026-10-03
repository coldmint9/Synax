import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('hides the managed target and its Windows cleanup process', () => {
  const spawn = vi.fn(() => new EventEmitter())
  const host = new EventEmitter() as EventEmitter & { platform: string; connected: boolean; exit: (code: number) => void; stderr: { write: (value: string) => void }; send: (value: unknown) => void }
  host.platform = 'win32'
  host.connected = true
  host.exit = vi.fn()
  host.stderr = { write: vi.fn() }
  host.send = vi.fn()
  const timer = { unref: vi.fn() }
  runInNewContext(readFileSync(new URL('./owned-process-runner.cjs', import.meta.url), 'utf8'), {
    require: () => ({ spawn }),
    process: host,
    setTimeout: () => timer,
  })

  host.emit('message', { type: 'start', command: 'cmd.exe', args: ['/c', 'agent.cmd'], shell: false })
  expect(spawn).toHaveBeenCalledWith('cmd.exe', ['/c', 'agent.cmd'], expect.objectContaining({ windowsHide: true }))

  const child = spawn.mock.results[0].value as EventEmitter & { pid: number }
  child.pid = 123
  host.emit('disconnect')
  expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '123', '/T', '/F'], expect.objectContaining({ windowsHide: true }))
})
