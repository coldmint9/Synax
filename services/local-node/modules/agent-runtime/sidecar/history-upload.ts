import { logger } from "../../../infrastructure/runtime/logger.js";
import { createHash } from "node:crypto";
import type { RuntimeSidecarClient } from "./sidecar-client.js";

/** Keep individual protobuf frames small while retaining the full CAS entity. */
export async function appendHistoryPayload(client: RuntimeSidecarClient, sessionId: string, requestId: string,
  payload: { objects: Array<{ kind: string; value: unknown }>; ifAbsent?: boolean },
): Promise<Uint8Array> {
  for (const object of payload.objects) {
    if (Buffer.byteLength(JSON.stringify([object.kind, object.value, []])) > 4 * 1024 * 1024)
      throw new Error("History entity exceeds the 4 MiB storage object budget.");
  }
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length <= 768 * 1024) return client.historyCommand({ sessionId, requestId, operation: "append_entities", payload });
  if (bytes.length > 8 * 1024 * 1024) throw new Error("History append exceeds the 8 MiB object batch budget.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blobId = `history-upload:${createHash("sha256").update(`${requestId}:${sha256}`).digest("hex")}`;
  const chunkSize = 192 * 1024;
  const total = Math.ceil(bytes.length / chunkSize);
  for (let index = 0; index < total; index++) {
    await client.historyCommand({ sessionId, requestId: `${blobId}:${index}`, operation: "put_blob_chunk",
      payload: { blobId, index, total, bytesHex: bytes.subarray(index * chunkSize, (index + 1) * chunkSize).toString("hex") } });
  }
  await client.historyCommand({ sessionId, requestId: `${blobId}:manifest`, operation: "put_blob_manifest",
    payload: { blobId, total, size: bytes.length, sha256 } });
  const result = await client.historyCommand({ sessionId, requestId, operation: "append_entities_blob", payload: { blobId, sha256 } });
  // The durable append receipt makes retries independent of these staging files.
  await client.historyCommand({ sessionId, requestId: `${blobId}:cleanup`, operation: "delete_blob", payload: { blobId } })
    .catch(error => logger.warn({ sessionId, blobId, error: String(error) }, "History upload staging cleanup failed"));
  return result;
}
