/**
 * Some gateways send only `...` as reasoning when no summary is available.
 * Keep these placeholders (including partial streamed dots) out of the visible
 * transcript. Do not impose a minimum length on actual reasoning, and keep the
 * original provider parts separately for protocol replay and signatures.
 */
export function hasDisplayableReasoning(content: string): boolean {
  return /[^\s.…]/u.test(content);
}
