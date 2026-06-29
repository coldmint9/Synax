import { spawn } from 'node:child_process'
import path from 'node:path'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'

const CURSOR_CLI_CANDIDATES = ['cursor-agent', 'agent'] as const

let cachedCursorCli: string | null | undefined

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function commandExists(commandName: string): Promise<boolean> {
  const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh'
  const args = process.platform === 'win32'
    ? ['/c', 'where', commandName.endsWith('.cmd') ? commandName : `${commandName}.cmd`]
    : ['-lc', `command -v ${commandName}`]
  return new Promise((resolve) => {
    const child = spawn(shell, args, { stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

async function probeCursorCliCandidates(): Promise<string | null> {
  for (const name of CURSOR_CLI_CANDIDATES) {
    if (await commandExists(name)) return name
  }
  const localAgent = path.join(homedir(), '.local', 'bin', 'agent')
  if (await isExecutable(localAgent)) return localAgent
  return null
}

export async function resolveCursorCliBinary(): Promise<string | null> {
  if (cachedCursorCli !== undefined) return cachedCursorCli
  cachedCursorCli = await probeCursorCliCandidates()
  return cachedCursorCli
}

export function resetCursorCliCacheForTests(): void {
  cachedCursorCli = undefined
}

export const CURSOR_CLI_INSTALL_HINT =
  'Install Cursor CLI: curl https://cursor.com/install -fsS | bash (provides `agent`), then run `agent login`.'
