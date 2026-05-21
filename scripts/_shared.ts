import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ROOT_DIR = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
export const WEB_DIR = join(ROOT_DIR, 'web')

export function readPort(name: string, fallback: number) {
  const raw = process.env[name]
  if (!raw) return fallback

  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function logStart(label: string, url: string) {
  console.log(`[${label}] ${url}`)
}

export async function ensureWorkspaceInstall() {
  const hasRootDeps = existsSync(join(ROOT_DIR, 'node_modules'))
  const hasWebDeps = existsSync(join(WEB_DIR, 'node_modules'))
  const hasTreeSitter = existsSync(join(ROOT_DIR, 'node_modules', 'tree-sitter'))
  const hasReactRefresh = existsSync(join(WEB_DIR, 'node_modules', 'react-refresh'))

  if (hasRootDeps && hasWebDeps && hasTreeSitter && hasReactRefresh) {
    return
  }

  console.log('[bootstrap] installing workspace dependencies...')
  const proc = spawnProcess(['npm', 'install'])
  const code = await waitForExit(proc)

  if (code !== 0) {
    process.exit(code)
  }
}

export function spawnProcess(cmd: string[], cwd = ROOT_DIR): ChildProcess {
  return spawn(cmd[0], cmd.slice(1), {
    cwd,
    env: withLocalNoProxy(process.env),
    stdio: 'inherit',
  })
}

export function waitForExit(proc: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    proc.on('exit', (code) => resolve(code ?? 0))
  })
}

function withLocalNoProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const localHosts = ['localhost', '127.0.0.1', '::1']
  const existing = `${env.NO_PROXY ?? ''},${env.no_proxy ?? ''}`
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const noProxy = [...new Set([...existing, ...localHosts])].join(',')

  return {
    ...env,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  }
}

export async function ensureBuiltServer() {
  if (existsSync(join(ROOT_DIR, 'server-dist', 'server.js'))) {
    return
  }

  console.log('[bootstrap] server-dist/server.js missing, building...')
  const proc = spawnProcess(['npm', 'run', 'build'])
  const code = await waitForExit(proc)

  if (code !== 0) {
    process.exit(code)
  }
}
