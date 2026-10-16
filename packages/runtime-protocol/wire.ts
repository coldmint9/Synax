export type SidecarBody =
  | { type: 'seed_ui'; sessionJson: Uint8Array }
  | { type: 'ui_snapshot' }
  | { type: 'ui_snapshot_response'; snapshotJson: Uint8Array }
  | { type: 'activate_run'; runJson: Uint8Array }
  | { type: 'hello'; token: string; clientId?: string }
  | { type: 'issue_ticket'; clientId: string }
  | { type: 'ticket'; token: string; expiresAtMs: number }
  | { type: 'credit'; throughSequence: number }
  | { type: 'health' }
  | { type: 'shutdown' }
  | { type: 'ping' }
  | { type: 'finish_run'; runId: string; status: string }
  | { type: 'admit_run'; bodyHash: string; runId: string }
  | {
      type: 'append_stream';
      runId: string;
      producerId: string;
      producerSequence: number;
      events: Array<{ kind: string; payload: Uint8Array }>;
      durability?: 'sync' | 'group_commit' | 'ephemeral';
    }
  | { type: 'snapshot' }
  | { type: 'replay'; after: number }
  | { type: 'subscribe'; after: number }
  | { type: 'ready'; protocol: string; transport: string; capabilities: string[] }
  | { type: 'health_response'; ok: boolean; protocol: string }
  | { type: 'pong' }
  | { type: 'ack'; request: string }
  | { type: 'error'; code: string; message: string; expected?: number; actual?: number }
  | { type: 'run_admission'; runId: string; epoch: number; revision: number; reused: boolean }
  | {
      type: 'snapshot_response';
      epoch: number;
      revision: number;
      activeRunId?: string;
      cursor: number;
      retainedFrom: number;
    }
  | {
      type: 'event_batch';
      events: Array<{ sequence: number; runId: string; kind: string; payload: Uint8Array }>;
    };

export interface SidecarEnvelope {
  requestId: string;
  sessionId: string;
  epoch: number;
  revision: number;
  body: SidecarBody;
}

const BODY_FIELDS: Record<SidecarBody['type'], number> = {
  hello: 10,
  health: 11,
  shutdown: 12,
  ping: 13,
  admit_run: 14,
  append_stream: 15,
  snapshot: 16,
  replay: 17,
  subscribe: 18,
  ready: 19,
  health_response: 20,
  pong: 21,
  ack: 22,
  error: 23,
  run_admission: 24,
  snapshot_response: 25,
  event_batch: 26,
  finish_run: 27,
  issue_ticket: 28,
  ticket: 29,
  credit: 30,
  seed_ui: 31,
  ui_snapshot: 32,
  ui_snapshot_response: 33,
  activate_run: 34,
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function varint(value: number | bigint): Uint8Array {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid unsigned protobuf integer.');
  let current = BigInt(value);
  if (current < 0n || current > 0xffffffffffffffffn) throw new Error('Protobuf uint64 overflow.');
  const bytes: number[] = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Uint8Array.from(bytes);
}

function fieldBytes(field: number, value: Uint8Array): Uint8Array {
  return concat(varint((field << 3) | 2), varint(value.length), value);
}

function fieldString(field: number, value: string): Uint8Array {
  return fieldBytes(field, utf8(value));
}

function fieldUint(field: number, value: number): Uint8Array {
  return concat(varint(field << 3), varint(value));
}

function bodyPayload(body: SidecarBody): Uint8Array {
  switch (body.type) {
    case 'seed_ui': return fieldBytes(1, body.sessionJson);
    case 'ui_snapshot': return new Uint8Array();
    case 'ui_snapshot_response': return fieldBytes(1, body.snapshotJson);
    case 'activate_run': return fieldBytes(1, body.runJson);
    case 'hello': return concat(fieldString(1, body.token), body.clientId ? fieldString(2, body.clientId) : new Uint8Array());
    case 'issue_ticket': return fieldString(1, body.clientId);
    case 'ticket': return concat(fieldString(1, body.token), fieldUint(2, body.expiresAtMs));
    case 'credit': return fieldUint(1, body.throughSequence);
    case 'health':
    case 'shutdown':
    case 'ping':
    case 'snapshot':
      return new Uint8Array();
    case 'finish_run':
      return concat(fieldString(1, body.runId), fieldString(2, body.status));
    case 'admit_run':
      return concat(fieldString(1, body.bodyHash), fieldString(2, body.runId));
    case 'append_stream':
      return concat(
        fieldString(1, body.runId),
        fieldString(2, body.producerId),
        fieldUint(3, body.producerSequence),
        ...body.events.map((event) =>
          fieldBytes(4, concat(fieldString(1, event.kind), fieldBytes(2, event.payload))),
        ),
        body.durability === undefined ? new Uint8Array() : fieldUint(5, body.durability === 'group_commit' ? 1 : body.durability === 'ephemeral' ? 2 : 0),
      );
    case 'replay':
    case 'subscribe':
      return fieldUint(1, body.after);
    case 'ready':
      return concat(
        fieldString(1, body.protocol),
        fieldString(2, body.transport),
        ...body.capabilities.map((capability) => fieldString(3, capability)),
      );
    case 'health_response':
      return concat(fieldUint(1, body.ok ? 1 : 0), fieldString(2, body.protocol));
    case 'pong':
      return new Uint8Array();
    case 'ack':
      return fieldString(1, body.request);
    case 'error':
      return concat(
        fieldString(1, body.code),
        fieldString(2, body.message),
        body.expected === undefined ? new Uint8Array() : fieldUint(3, body.expected),
        body.actual === undefined ? new Uint8Array() : fieldUint(4, body.actual),
      );
    case 'run_admission':
      return concat(
        fieldString(1, body.runId),
        fieldUint(2, body.epoch),
        fieldUint(3, body.revision),
        fieldUint(4, body.reused ? 1 : 0),
      );
    case 'snapshot_response':
      return concat(
        fieldUint(1, body.epoch),
        fieldUint(2, body.revision),
        body.activeRunId === undefined ? new Uint8Array() : fieldString(3, body.activeRunId),
        fieldUint(4, body.cursor),
        fieldUint(5, body.retainedFrom),
      );
    case 'event_batch':
      return concat(
        ...body.events.map((event) =>
          fieldBytes(
            1,
            concat(
              fieldUint(1, event.sequence),
              fieldString(2, event.runId),
              fieldString(3, event.kind),
              fieldBytes(4, event.payload),
            ),
          ),
        ),
      );
  }
}

export function encodeEnvelope(envelope: SidecarEnvelope): Uint8Array {
  return concat(
    envelope.requestId ? fieldString(1, envelope.requestId) : new Uint8Array(),
    envelope.sessionId ? fieldString(2, envelope.sessionId) : new Uint8Array(),
    envelope.epoch ? fieldUint(3, envelope.epoch) : new Uint8Array(),
    envelope.revision ? fieldUint(4, envelope.revision) : new Uint8Array(),
    fieldBytes(BODY_FIELDS[envelope.body.type], bodyPayload(envelope.body)),
  );
}

type Field = { field: number; wire: number; value: Uint8Array | bigint };

function readVarint(bytes: Uint8Array, offset: { value: number }): bigint {
  let result = 0n;
  let shift = 0n;
  while (offset.value < bytes.length) {
    const byte = bytes[offset.value++];
    if (shift > 63n || (shift === 63n && byte > 1)) throw new Error('Protobuf uint64 overflow.');
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
  }
  throw new Error('Truncated sidecar protobuf varint.');
}

function readFields(bytes: Uint8Array): Field[] {
  const fields: Field[] = [];
  const offset = { value: 0 };
  while (offset.value < bytes.length) {
    const key = Number(readVarint(bytes, offset));
    if (!Number.isSafeInteger(key) || key < 8 || key > 0xffffffff) throw new Error('Invalid protobuf field key.');
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      fields.push({ field, wire, value: readVarint(bytes, offset) });
    } else if (wire === 2) {
      const length = Number(readVarint(bytes, offset));
      const end = offset.value + length;
      if (end > bytes.length) throw new Error('Truncated sidecar protobuf bytes field.');
      fields.push({ field, wire, value: bytes.slice(offset.value, end) });
      offset.value = end;
    } else if (wire === 1) {
      if (offset.value + 8 > bytes.length) throw new Error('Truncated protobuf fixed64.');
      fields.push({ field, wire, value: bytes.slice(offset.value, offset.value + 8) });
      offset.value += 8;
    } else if (wire === 5) {
      if (offset.value + 4 > bytes.length) throw new Error('Truncated protobuf fixed32.');
      fields.push({ field, wire, value: bytes.slice(offset.value, offset.value + 4) });
      offset.value += 4;
    } else {
      throw new Error(`Unsupported sidecar protobuf wire type ${wire}.`);
    }
  }
  return fields;
}

function fieldsOf(bytes: Uint8Array, field: number): Field[] {
  return readFields(bytes).filter((item) => item.field === field);
}

function firstBytes(bytes: Uint8Array, field: number): Uint8Array | undefined {
  const value = fieldsOf(bytes, field)[0]?.value;
  return value instanceof Uint8Array ? value : undefined;
}

function firstString(bytes: Uint8Array, field: number): string | undefined {
  const value = firstBytes(bytes, field);
  return value === undefined ? undefined : decodeUtf8(value);
}

function firstNumber(bytes: Uint8Array, field: number): number {
  const value = fieldsOf(bytes, field)[0]?.value;
  if (typeof value === 'bigint' && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Protobuf integer exceeds the JavaScript safe range.');
  return typeof value === 'bigint' ? Number(value) : 0;
}

function firstBool(bytes: Uint8Array, field: number): boolean {
  return firstNumber(bytes, field) !== 0;
}

function decodeBody(field: number, bytes: Uint8Array): SidecarBody {
  switch (field) {
    case 31: return { type: 'seed_ui', sessionJson: firstBytes(bytes, 1) ?? new Uint8Array() };
    case 32: return { type: 'ui_snapshot' };
    case 33: return { type: 'ui_snapshot_response', snapshotJson: firstBytes(bytes, 1) ?? new Uint8Array() };
    case 34: return { type: 'activate_run', runJson: firstBytes(bytes, 1) ?? new Uint8Array() };
    case 27: return { type: 'finish_run', runId: firstString(bytes, 1) ?? '', status: firstString(bytes, 2) ?? '' };
    case 10: return { type: 'hello', token: firstString(bytes, 1) ?? '', ...(firstString(bytes, 2) ? { clientId: firstString(bytes, 2) } : {}) };
    case 28: return { type: 'issue_ticket', clientId: firstString(bytes, 1) ?? '' };
    case 29: return { type: 'ticket', token: firstString(bytes, 1) ?? '', expiresAtMs: firstNumber(bytes, 2) };
    case 30: return { type: 'credit', throughSequence: firstNumber(bytes, 1) };
    case 11: return { type: 'health' };
    case 12: return { type: 'shutdown' };
    case 13: return { type: 'ping' };
    case 14: return { type: 'admit_run', bodyHash: firstString(bytes, 1) ?? '', runId: firstString(bytes, 2) ?? '' };
    case 15: return {
      type: 'append_stream',
      runId: firstString(bytes, 1) ?? '',
      producerId: firstString(bytes, 2) ?? '',
      producerSequence: firstNumber(bytes, 3),
      durability: decodeDurability(firstNumber(bytes, 5)),
      events: fieldsOf(bytes, 4).map((item) => {
        const event = item.value as Uint8Array;
        return { kind: firstString(event, 1) ?? '', payload: firstBytes(event, 2) ?? new Uint8Array() };
      }),
    };
    case 16: return { type: 'snapshot' };
    case 17: return { type: 'replay', after: firstNumber(bytes, 1) };
    case 18: return { type: 'subscribe', after: firstNumber(bytes, 1) };
    case 19: return { type: 'ready', protocol: firstString(bytes, 1) ?? '', transport: firstString(bytes, 2) ?? '', capabilities: fieldsOf(bytes, 3).map((item) => decodeUtf8(item.value as Uint8Array)) };
    case 20: return { type: 'health_response', ok: firstBool(bytes, 1), protocol: firstString(bytes, 2) ?? '' };
    case 21: return { type: 'pong' };
    case 22: return { type: 'ack', request: firstString(bytes, 1) ?? '' };
    case 23: return { type: 'error', code: firstString(bytes, 1) ?? '', message: firstString(bytes, 2) ?? '', expected: fieldsOf(bytes, 3).length ? firstNumber(bytes, 3) : undefined, actual: fieldsOf(bytes, 4).length ? firstNumber(bytes, 4) : undefined };
    case 24: return { type: 'run_admission', runId: firstString(bytes, 1) ?? '', epoch: firstNumber(bytes, 2), revision: firstNumber(bytes, 3), reused: firstBool(bytes, 4) };
    case 25: return { type: 'snapshot_response', epoch: firstNumber(bytes, 1), revision: firstNumber(bytes, 2), activeRunId: firstString(bytes, 3), cursor: firstNumber(bytes, 4), retainedFrom: firstNumber(bytes, 5) };
    case 26: return { type: 'event_batch', events: fieldsOf(bytes, 1).map((item) => {
      const event = item.value as Uint8Array;
      return { sequence: firstNumber(event, 1), runId: firstString(event, 2) ?? '', kind: firstString(event, 3) ?? '', payload: firstBytes(event, 4) ?? new Uint8Array() };
    }) };
    default: throw new Error(`Unsupported sidecar response body field ${field}.`);
  }
}

function decodeDurability(value: number): 'sync' | 'group_commit' | 'ephemeral' {
  return value === 1 ? 'group_commit' : value === 2 ? 'ephemeral' : 'sync';
}

export function decodeEnvelope(bytes: Uint8Array): SidecarEnvelope {
  const fields = readFields(bytes);
  const bodyField = fields.reverse().find((item) => item.field >= 10 && item.field <= 34 && item.wire === 2);
  if (!bodyField) throw new Error('Sidecar envelope has no body.');
  return {
    requestId: firstString(bytes, 1) ?? '',
    sessionId: firstString(bytes, 2) ?? '',
    epoch: firstNumber(bytes, 3),
    revision: firstNumber(bytes, 4),
    body: decodeBody(bodyField.field, bodyField.value as Uint8Array),
  };
}
