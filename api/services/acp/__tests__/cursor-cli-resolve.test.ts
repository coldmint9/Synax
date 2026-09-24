import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { resetCursorCliCacheForTests, resolveCursorCliBinary } from '../cursor-cli-resolve.js'

afterEach(() => {
  resetCursorCliCacheForTests()
  spawnMock.mockReset()
})

it('hides Windows Cursor CLI probes', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0))
    return child
  })
  try {
    await expect(resolveCursorCliBinary()).resolves.toBe('cursor-agent')
    expect(spawnMock).toHaveBeenCalledWith('cmd.exe', ['/c', 'where', 'cursor-agent.cmd'], {
      stdio: 'ignore', windowsHide: true,
    })
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})
