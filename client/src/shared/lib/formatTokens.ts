/** Compact token counts, e.g. 12300 → "12.3K", 1000000 → "1M". */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 2)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return String(Math.round(tokens))
}

/**
 * Context window label. Shared by the provider settings card and the session
 * usage bar so both render the configured window identically (1M stays "1M").
 */
export function formatContextLimit(tokens: number): string {
  if (!tokens || tokens <= 0) return '—'
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens % 1000 === 0) return `${tokens / 1000}K`
  return String(tokens)
}
