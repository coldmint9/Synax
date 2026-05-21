import { ROOT_DIR, ensureBuiltServer, ensureWorkspaceInstall, logStart, spawnProcess, waitForExit } from './_shared'

await ensureWorkspaceInstall()
await ensureBuiltServer()
logStart('start:api', 'starting dist/server.js')

const proc = spawnProcess(['node', './server-dist/server.js'], ROOT_DIR)
const code = await waitForExit(proc)

process.exit(code)
