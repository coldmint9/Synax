import { createHash } from 'node:crypto';
import { ArtifactError, ARTIFACT_LIMITS, type ArtifactPublishInput, type ArtifactState } from './contracts.js';

export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function validatePublish(input: ArtifactPublishInput): void {
  if (!input || Object.keys(input).some(key => !['sourcePath','title','sourceKind','artifactId','baseRevisionId','idempotencyKey'].includes(key)) || !['html', 'react'].includes(input.sourceKind)
    || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200
    || typeof input.sourcePath !== 'string' || input.sourcePath.length > 1024
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 256
    || (!!input.artifactId !== !!input.baseRevisionId)
    || [input.artifactId, input.baseRevisionId].some(v => v !== undefined && (typeof v !== 'string' || !v || v.length > 256))) {
    throw new ArtifactError('INVALID_SOURCE', 'Invalid artifact publication request.');
  }
}

/** Accept JSON only, without prototype-mutating keys or pathological nesting. */
export function safeJson(value: unknown, maxBytes: number): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 20000 || depth > 40) throw new ArtifactError('RESOURCE_LIMIT', 'State complexity limit exceeded.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') throw new ArtifactError('INVALID_SOURCE', 'State must contain only JSON values.');
    if (ancestors.has(item)) throw new ArtifactError('INVALID_SOURCE', 'Circular state is not supported.');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new ArtifactError('INVALID_SOURCE', 'State must use plain objects.');
    ancestors.add(item);
    for (const key of Object.keys(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ArtifactError('INVALID_SOURCE', 'Unsafe state key.');
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in descriptor)) throw new ArtifactError('INVALID_SOURCE', 'State accessors are not supported.');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxBytes) throw new ArtifactError('RESOURCE_LIMIT', 'State size limit exceeded.');
  return encoded;
}
export function validateState(state: Omit<ArtifactState, 'etag'>, expectedEtag: number): string {
  if (!state || ['privateState','modelState','controls','schemaVersion'].some(key => !Object.hasOwn(state,key)) || !Number.isSafeInteger(expectedEtag) || expectedEtag < 0 || expectedEtag >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(state.schemaVersion) || state.schemaVersion < 1
    || !state.controls || typeof state.controls !== 'object' || Array.isArray(state.controls)
    || Object.keys(state.controls).length > ARTIFACT_LIMITS.controls
    || Object.keys(state).some(key => !['privateState', 'modelState', 'controls', 'schemaVersion'].includes(key))) {
    throw new ArtifactError('INVALID_SOURCE', 'Invalid artifact state.');
  }
  return safeJson(state, ARTIFACT_LIMITS.stateBytes);
}
