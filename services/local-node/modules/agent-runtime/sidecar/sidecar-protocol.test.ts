import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope } from "./sidecar-protocol.js";

describe("runtime sidecar protobuf codec", () => {
  it('encodes persisted snapshot commands without text conversion', () => {
    for (const body of [
      { type: 'ui_snapshot' as const },
      { type: 'seed_ui' as const, sessionJson: new Uint8Array([0, 128, 255]) },
      { type: 'ui_snapshot_response' as const, snapshotJson: new Uint8Array([0, 128, 255]) },
      { type: 'activate_run' as const, runJson: new Uint8Array([0, 128, 255]) },
      { type: 'queue_mutation' as const, operation: 'force', payload: new Uint8Array([0, 128, 255]) },
      { type: 'queue_read' as const },
      { type: 'queue_state' as const, queueJson: new Uint8Array([0, 128, 255]) },
      { type: 'session_list' as const, after: 'session-64' },
      { type: 'control_command' as const, operation: 'permission_reply', payload: new Uint8Array([0, 128, 255]) },
      { type: 'control_state' as const, stateJson: new Uint8Array([0, 128, 255]) },
      { type: 'event_batch' as const, events: [{ sequence: 0, runId: 'r', kind: 'heartbeat', payload: new Uint8Array([0, 128, 255]), ephemeral: true }] },
      { type: 'admit_run' as const, bodyHash: 'hash', runId: 'r', queueItemJson: new Uint8Array([0, 128, 255]), runJson: new Uint8Array([1, 2, 3]) },
      { type: 'finish_run' as const, runId: 'r', status: 'failed', runJson: new Uint8Array([0, 128, 255]) },
    ]) {
      const envelope = { requestId: 'ui', sessionId: 's', epoch: 0, revision: 0, body };
      expect(decodeEnvelope(encodeEnvelope(envelope))).toEqual(envelope);
    }
  });

  it("rejects negative cursors and overlong varints without looping", () => {
    expect(() => encodeEnvelope({ requestId: '', sessionId: 's', epoch: 0, revision: 0,
      body: { type: 'subscribe', after: -1 } })).toThrow('Invalid unsigned protobuf integer');
    expect(() => decodeEnvelope(new Uint8Array([8, ...Array(11).fill(255)]))).toThrow('uint64 overflow');
    expect(() => decodeEnvelope(new Uint8Array([9, 1]))).toThrow('Truncated protobuf fixed64');
  });

  it("preserves a fenced completion command", () => {
    const message = { requestId: "finish-1", sessionId: "s", epoch: 2, revision: 3,
      body: { type: "finish_run" as const, runId: "r", status: "completed" } };
    expect(decodeEnvelope(encodeEnvelope(message))).toEqual(message);
  });

  it("round trips an admission command", () => {
    const encoded = encodeEnvelope({
      requestId: "req-1",
      sessionId: "session-1",
      epoch: 1,
      revision: 0,
      body: { type: "admit_run", bodyHash: "body", runId: "run-1" },
    });
    expect(decodeEnvelope(encoded)).toEqual({
      requestId: "req-1",
      sessionId: "session-1",
      epoch: 1,
      revision: 0,
      body: { type: "admit_run", bodyHash: "body", runId: "run-1" },
    });
  });

  it("round trips stream payload bytes without text conversion", () => {
    const encoded = encodeEnvelope({
      requestId: "req-2",
      sessionId: "session-1",
      epoch: 1,
      revision: 1,
      body: {
        type: "append_stream",
        runId: "run-1",
        producerId: "worker-1",
        producerSequence: 4,
        events: [{ kind: "message_delta", payload: new Uint8Array([0, 1, 255]) }],
      },
    });
    const decoded = decodeEnvelope(encoded);
    expect(decoded.body).toMatchObject({
      type: "append_stream",
      runId: "run-1",
      producerId: "worker-1",
      producerSequence: 4,
    });
    expect(Array.from(decoded.body.type === "append_stream" ? decoded.body.events[0].payload : [])).toEqual([0, 1, 255]);
  });
});
