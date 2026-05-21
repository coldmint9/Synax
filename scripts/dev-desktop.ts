import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ROOT_DIR, WEB_DIR, ensureWorkspaceInstall, logStart, readPort, spawnProcess, waitForExit } from './_shared'

const apiPort = readPort('PORT', 3210)
const webPort = readPort('WEB_PORT', 5173)
const webHost = process.env.WEB_HOST ?? '0.0.0.0'

await ensureWorkspaceInstall()

// Initial compile of electron TS
const buildElectron = spawnProcess(['npx', 'tsc', '-p', 'electron/tsconfig.json'], ROOT_DIR)
await waitForExit(buildElectron)

logStart('dev:desktop', `API http://localhost:${apiPort}`)
logStart('dev:desktop', `Web http://${webHost}:${webPort}`)

const api = spawnProcess(['npx', 'tsx', '--watch', 'api/server.ts'], ROOT_DIR)
const web = spawnProcess(['npx', 'vite', '--force', '--host', webHost, '--port', String(webPort)], WEB_DIR)

// Watch electron source and recompile on change
const tscWatch = spawnProcess(['npx', 'tsc', '-p', 'electron/tsconfig.json', '--watch', '--preserveWatchOutput'], ROOT_DIR)

async function waitForServer(url: string, retries = 60): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await fetch(url)
      return
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Server at ${url} failed to start`)
}

await Promise.all([
  waitForServer(`http://127.0.0.1:${apiPort}/api/health`),
  waitForServer(`http://${webHost === '0.0.0.0' ? '127.0.0.1' : webHost}:${webPort}`),
])

logStart('dev:desktop', 'Servers ready, launching Electron with hot-reload...')

const electronmonBin = join(ROOT_DIR, 'node_modules', '.bin', 'electronmon')

const electron = spawn(electronmonBin, ['.'], {
  cwd: ROOT_DIR,
  env: {
    ...process.env,
    ELECTRON_SKIP_SIDECAR: '1',
    WEB_PORT: String(webPort),
  },
  stdio: 'inherit',
})

const winner = await Promise.race([waitForExit(api), waitForExit(web), waitForExit(electron)])

api.kill()
web.kill()
electron.kill()
tscWatch.kill()

process.exit(winner)
