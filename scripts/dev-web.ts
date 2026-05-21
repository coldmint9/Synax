import { WEB_DIR, ensureWorkspaceInstall, logStart, readPort, spawnProcess, waitForExit } from './_shared'

const port = readPort('WEB_PORT', 5173)
const host = process.env.WEB_HOST ?? '0.0.0.0'

await ensureWorkspaceInstall()
logStart('dev:web', `starting web on http://${host}:${port}`)

const proc = spawnProcess(['npx', 'vite', '--force', '--host', host, '--port', String(port)], WEB_DIR)
const code = await waitForExit(proc)

process.exit(code)
