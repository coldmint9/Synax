const counters = new Map<string, number>();

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function makeRuntimeId(prefix: string): string {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  return `${prefix}_${Date.now().toString(36)}_${next.toString(36)}`;
}

export function resetRuntimeIdsForTests(): void {
  counters.clear();
}
