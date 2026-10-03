import { CLIENT_DIR, ROOT_DIR, ensureWorkspaceInstall, logStart, readPort, resolveLocalServiceCommand, spawnProcess, waitForExit } from './_shared'

const apiPort = readPort('PORT', 3210)
const webPort = readPort('WEB_PORT', 5173)
const webHost = process.env.WEB_HOST ?? '0.0.0.0'

await ensureWorkspaceInstall()
logStart('dev:all', `API http://localhost:${apiPort}`)
logStart('dev:all', `Web http://${webHost}:${webPort}`)

const localService = spawnProcess(resolveLocalServiceCommand(), ROOT_DIR)
const client = spawnProcess(['npx', 'vite', '--force', '--host', webHost, '--port', String(webPort)], CLIENT_DIR)

const winner = await Promise.race([waitForExit(localService), waitForExit(client)])

localService.kill()
client.kill()

process.exit(winner)
