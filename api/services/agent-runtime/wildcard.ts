// Adapted from the OpenCode wildcard matcher so runtime permission rules
// share the same `*` / `?` semantics for tool and path matching.
export function matchWildcard(value: string, pattern: string): boolean {
  const normalizedValue = value.replaceAll('\\', '/');
  const normalizedPattern = pattern.replaceAll('\\', '/');

  let escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  if (escaped.endsWith(' .*')) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  }

  const flags = process.platform === 'win32' ? 'si' : 's';
  return new RegExp(`^${escaped}$`, flags).test(normalizedValue);
}
