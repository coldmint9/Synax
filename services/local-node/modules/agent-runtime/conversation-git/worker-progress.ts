import { createHash } from 'node:crypto';

/** Receipt clocks/counters and prose are not evidence of useful new work. */
function evidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(evidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['taskRevision', 'mrVersion', 'version', 'execution', 'updatedAt', 'createdAt', 'finishedAt', 'rationale', 'summary'].includes(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, evidence(item)]));
}

export function mergeProgressIdentity(toolId: string, args: unknown, output: unknown): string | undefined {
  if (['git.merge.worker.report', 'git.merge.worker.waiting'].includes(toolId)) return undefined;
  return createHash('sha256').update(JSON.stringify([toolId, evidence(args), evidence(output)])).digest('hex');
}
