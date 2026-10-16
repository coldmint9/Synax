export interface RuntimeRecordState {
  status: string;
  activeRunId: string | null;
  pendingResumeToken: string | null;
  blockedReason: string | null;
  updatedAt: string;
}
export interface RuntimePayload {
  schema: 1;
  chunk: { type: string; [key: string]: unknown };
  state: RuntimeRecordState;
}

/** State is committed alongside the chunk; never synthesize it at replay time. */
export function decodeRuntimePayload(bytes: Uint8Array): RuntimePayload {
  const value = JSON.parse(new TextDecoder().decode(bytes));
  const state = value?.state;
  const nullableString = (value: unknown) => value === null || typeof value === 'string';
  if (value?.schema !== 1 || typeof value.chunk?.type !== 'string' ||
      !state || typeof state.status !== 'string' || typeof state.updatedAt !== 'string' ||
      !nullableString(state.activeRunId) || !nullableString(state.pendingResumeToken) || !nullableString(state.blockedReason)) {
    throw new Error('Unsupported runtime event payload; stream data requires migration.');
  }
  return value as RuntimePayload;
}
