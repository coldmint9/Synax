import { ROOT_DIR, ensureWorkspaceInstall, logStart, readPort, resolveLocalServiceCommand, spawnProcess, waitForExit } from './_shared'

const port = readPort('PORT', 3210)

await ensureWorkspaceInstall()
logStart('dev:local', `starting local service on http://localhost:${port}`)

const proc = spawnProcess(resolveLocalServiceCommand(), ROOT_DIR)
const code = await waitForExit(proc)

process.exit(code)
