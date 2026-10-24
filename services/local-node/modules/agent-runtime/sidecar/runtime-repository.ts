import { randomUUID } from "node:crypto";
import { RuntimeSidecarClient, RuntimeSidecarError } from "./sidecar-client.js";
import { readHistoryList } from './history-pages.js';
import { appendHistoryPayload } from './history-upload.js';
import type { AgentSession } from "../contracts.js";

let connection:
  | { socket: string; token: string; client: RuntimeSidecarClient }
  | undefined;
export function runtimeClient(): RuntimeSidecarClient {
  const socket = process.env.SYNAX_RUNTIME_SIDECAR_SOCKET;
  const token = process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
  if (!socket || !token)
    throw new Error("Rust runtime connection is not ready.");
  if (
    !connection ||
    connection.socket !== socket ||
    connection.token !== token
  ) {
    connection?.client.close();
    connection = {
      socket,
      token,
      client: new RuntimeSidecarClient({ socketPath: socket, token }),
    };
  }
  return connection.client;
}
export const decode = <T,>(bytes: Uint8Array): T =>
  JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
export async function patchRuntime(
  sessionId: string,
  operation: string,
  payload: unknown,
  requestId: string = randomUUID(),
) {
  const client = runtimeClient();
  for (let attempt = 0; ; attempt++) {
    const fence = await client.snapshot(sessionId);
    try {
      return decode<Record<string, unknown>>(
        (
          await client.controlCommand({
            sessionId,
            requestId,
            operation,
            payload,
            epoch: fence.epoch,
            revision: fence.revision,
          })
        ).stateJson,
      );
    } catch (error) {
      if (
        !(error instanceof RuntimeSidecarError) ||
        error.code !== "REVISION_CONFLICT" ||
        attempt >= 7
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, 10 * 2 ** attempt)));
    }
  }
}
export async function seedSession(session: AgentSession): Promise<void> {
  await runtimeClient().seedUi(
    session.id,
    Buffer.from(JSON.stringify(session)),
  );
}
export async function persistEntity(
  sessionId: string,
  kind: string,
  value: unknown,
): Promise<void> {
  await appendHistoryPayload(runtimeClient(), sessionId, randomUUID(), { objects: [{ kind, value }] });
}
export async function listEntities<T>(
  sessionId: string,
  operation: string,
): Promise<T[]> {
  return readHistoryList<T>(runtimeClient(), sessionId, operation);
}
