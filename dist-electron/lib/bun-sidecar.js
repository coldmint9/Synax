import { spawn } from 'node:child_process';
import { app } from 'electron';
import path from 'node:path';
import net from 'node:net';
import { getDataRoot, getResourcePath } from './data-paths.js';
let sidecar = null;
let assignedPort = 3210;
export function getSidecarPort() {
    return assignedPort;
}
async function findFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object') {
                const port = addr.port;
                server.close(() => resolve(port));
            }
            else {
                reject(new Error('Failed to get port'));
            }
        });
        server.on('error', reject);
    });
}
function getBunPath() {
    if (app.isPackaged) {
        const binary = process.platform === 'win32' ? 'bun.exe' : 'bun';
        return getResourcePath('vendor', binary);
    }
    return process.env.BUN_PATH || 'bun';
}
function getServerEntry() {
    if (app.isPackaged) {
        return getResourcePath('api', 'server.ts');
    }
    return path.resolve(app.getAppPath(), 'api', 'server.ts');
}
export async function startSidecar() {
    assignedPort = await findFreePort();
    const bunPath = getBunPath();
    const entry = getServerEntry();
    const dataRoot = getDataRoot();
    const env = {
        ...process.env,
        PORT: String(assignedPort),
        DATA_ROOT: dataRoot,
        NODE_ENV: app.isPackaged ? 'production' : 'development',
    };
    sidecar = spawn(bunPath, ['run', entry], {
        cwd: app.isPackaged ? process.resourcesPath : app.getAppPath(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    sidecar.on('exit', (code) => {
        console.log(`[sidecar] exited with code ${code}`);
        sidecar = null;
    });
    sidecar.stdout?.on('data', (d) => process.stdout.write(d));
    sidecar.stderr?.on('data', (d) => process.stderr.write(d));
    await waitForHealth(assignedPort);
    return assignedPort;
}
async function waitForHealth(port, retries = 30) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/health`);
            if (res.ok)
                return;
        }
        catch { }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Sidecar failed to start on port ${port}`);
}
export function stopSidecar() {
    if (!sidecar)
        return;
    sidecar.kill('SIGTERM');
    setTimeout(() => {
        if (sidecar && !sidecar.killed)
            sidecar.kill('SIGKILL');
    }, 3000);
}
