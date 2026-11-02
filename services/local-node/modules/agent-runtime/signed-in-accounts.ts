/**
 * Account scopes this machine is signed in to, for prompt and skill gating.
 *
 * The kernel build ships without an account system, so no scope is ever
 * available. The API is kept because prompt composition and skill gating call
 * it unconditionally; keeping the shape lets an account provider be mounted as
 * an addition instead of a rewrite.
 */
export function signedInAccountTags(): string[] {
  return [];
}

/** Tests and explicit sign-in transitions must not observe a stale scope. */
export function resetSignedInAccountCache(): void {}
