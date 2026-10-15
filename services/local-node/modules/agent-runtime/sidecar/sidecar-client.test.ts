import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeSidecarClient, RuntimeSidecarError } from './sidecar-client.js';
import { decodeEnvelope, encodeEnvelope, type SidecarEnvelope } from './sidecar-protocol.js';

const sockets: Array<{ server: net.Server; root: string }> = [];

afterEach(async () => {
  await Promise.all(
    sockets.splice(0).map(
      ({ server, root }) => new Promise<void>((resolve) => server.close(() => { rmSync(root, { recursive: true, force: true }); resolve(); })),
    ),
  );
});

function startServer(handler: (socket: net.Socket, envelope: SidecarEnvelope) => void): Promise<{ path: string; server: net.Server }> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (buffer.length < size + 4) return;
        const frame = buffer.subarray(4, size + 4);
        buffer = buffer.subarray(size + 4);
        handler(socket, decodeEnvelope(frame));
      }
    });
  });
  const root = mkdtempSync(join(tmpdir(), 'synax-sidecar-client-test-'));
  const socketPath = join(root, 'runtime.sock');
  sockets.push({ server, root });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve({ path: socketPath, server }));
  });
}

function send(socket: net.Socket, envelope: SidecarEnvelope): void {
  const body = Buffer.from(encodeEnvelope(envelope));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  socket.write(Buffer.concat([header, body]));
}

describe('RuntimeSidecarClient', () => {
  it('correlates a health request after the binary hello handshake', async () => {
    const bound = await startServer((socket, envelope) => {
      if (envelope.body.type === 'hello') {
        send(socket, {
          requestId: '', sessionId: '', epoch: 0, revision: 0,
          body: { type: 'ready', protocol: 'synax.runtime.v2', transport: 'unix', capabilities: ['health'] },
        });
      } else if (envelope.body.type === 'health') {
        send(socket, {
          requestId: envelope.requestId, sessionId: '', epoch: 0, revision: 0,
          body: { type: 'health_response', ok: true, protocol: 'synax.runtime.v2' },
        });
      }
    });
    const client = new RuntimeSidecarClient({ socketPath: bound.path, token: 'token' });
    await expect(client.connect()).resolves.toMatchObject({ protocol: 'synax.runtime.v2' });
    await expect(client.health()).resolves.toMatchObject({ ok: true });
    client.close();
  });

  it('maps sidecar errors while preserving expected and actual revisions', async () => {
    const bound = await startServer((socket, envelope) => {
      if (envelope.body.type === 'hello') {
        send(socket, {
          requestId: '', sessionId: '', epoch: 0, revision: 0,
          body: { type: 'ready', protocol: 'synax.runtime.v2', transport: 'unix', capabilities: [] },
        });
      } else {
        send(socket, {
          requestId: envelope.requestId, sessionId: envelope.sessionId, epoch: envelope.epoch, revision: envelope.revision,
          body: { type: 'error', code: 'REVISION_CONFLICT', message: 'stale', expected: 2, actual: 3 },
        });
      }
    });
    const client = new RuntimeSidecarClient({ socketPath: bound.path, token: 'token' });
    await expect(client.health()).rejects.toBeInstanceOf(RuntimeSidecarError);
    client.close();
  });
});
