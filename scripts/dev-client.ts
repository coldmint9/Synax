import { CLIENT_DIR, ensureWorkspaceInstall, logStart, readPort, spawnProcess, waitForExit } from './_shared'

const port = readPort('WEB_PORT', 5173)
const host = process.env.WEB_HOST ?? '0.0.0.0'

await ensureWorkspaceInstall()
logStart('dev:client', `starting client on http://${host}:${port}`)

const proc = spawnProcess(['npx', 'vite', '--force', '--host', host, '--port', String(port)], CLIENT_DIR)
const code = await waitForExit(proc)

process.exit(code)
