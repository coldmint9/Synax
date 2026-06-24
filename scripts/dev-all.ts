import { ROOT_DIR, WEB_DIR, ensureWorkspaceInstall, logStart, readPort, resolveApiDevCommand, spawnProcess, waitForExit } from './_shared'

const apiPort = readPort('PORT', 3210)
const webPort = readPort('WEB_PORT', 5173)
const webHost = process.env.WEB_HOST ?? '0.0.0.0'

await ensureWorkspaceInstall()
logStart('dev:all', `API http://localhost:${apiPort}`)
logStart('dev:all', `Web http://${webHost}:${webPort}`)

const api = spawnProcess(resolveApiDevCommand(), ROOT_DIR)
const web = spawnProcess(['npx', 'vite', '--force', '--host', webHost, '--port', String(webPort)], WEB_DIR)

const winner = await Promise.race([waitForExit(api), waitForExit(web)])

api.kill()
web.kill()

process.exit(winner)
