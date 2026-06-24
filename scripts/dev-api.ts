import { ROOT_DIR, ensureWorkspaceInstall, logStart, readPort, resolveApiDevCommand, spawnProcess, waitForExit } from './_shared'

const port = readPort('PORT', 3210)

await ensureWorkspaceInstall()
logStart('dev:api', `starting API on http://localhost:${port}`)

const proc = spawnProcess(resolveApiDevCommand(), ROOT_DIR)
const code = await waitForExit(proc)

process.exit(code)
