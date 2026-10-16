import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getDataRoot } from './data-paths.js';
import { startSidecar } from './node-sidecar.js';

/** Called only after the main process validates the requesting frame. */
export async function getRuntimeConnection(sessionId: unknown, clientId: unknown, snapshot: unknown) {
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 256 ||
      typeof clientId !== 'string' || clientId.length < 1 || clientId.length > 128 || typeof snapshot !== 'boolean')
    throw new Error('Invalid runtime connection request.');
  const port = await startSidecar();
  const token = (await readFile(path.join(getDataRoot(), 'runtime-access-token'), 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/runtime-ticket`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ clientId, snapshot }), signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Runtime connection request failed (${response.status}).`);
  return response.json();
}
