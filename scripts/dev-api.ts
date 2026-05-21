import { ROOT_DIR, ensureWorkspaceInstall, logStart, readPort, spawnProcess, waitForExit } from './_shared'

const port = readPort('PORT', 3210)

await ensureWorkspaceInstall()
logStart('dev:api', `starting API on http://localhost:${port}`)

const proc = spawnProcess(['npx', 'tsx', '--watch', 'api/server.ts'], ROOT_DIR)
const code = await waitForExit(proc)

process.exit(code)
