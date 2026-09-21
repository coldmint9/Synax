import { createServer } from "node:net";

/** An owned, local reject-only proxy. Unlike an assumed unused port it cannot be
 * occupied by another service. Nothing is parsed, logged, forwarded, or resolved.
 * Used as defense in depth for Chromium networking outside webRequest (WebRTC).
 */
export function createDenyProxy(): Promise<{ url: string; close(): void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.maxConnections = 8;
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("POLICY_BLOCKED"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => server.close(),
      });
    });
  });
}
