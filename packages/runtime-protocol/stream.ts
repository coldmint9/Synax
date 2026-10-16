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

/** Both the browser and HTTP compatibility gateway validate the persisted snapshot. */
export function decodeUiSnapshot(bytes: Uint8Array, sessionId: string) {
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (value?.session?.id !== sessionId || typeof value.session.status !== 'string' ||
      !Number.isSafeInteger(value.cursor) || value.cursor < 0 ||
      !Array.isArray(value.liveChunks) || value.liveChunks.some((chunk: { type?: unknown }) => typeof chunk?.type !== 'string') ||
      !Array.isArray(value.completedStepIds) || value.completedStepIds.some((id: unknown) => typeof id !== 'string') ||
      !(value.run === null || (typeof value.run?.id === 'string' && value.run.sessionId === sessionId))) {
    throw new Error('Invalid persisted runtime UI snapshot.');
  }
  return value;
}
