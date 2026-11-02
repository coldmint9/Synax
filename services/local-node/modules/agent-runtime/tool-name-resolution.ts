/**
 * Deterministic resolution of a model-emitted tool name to a runtime tool ID.
 *
 * Tool names are not preserved verbatim on their way to a model: provider wire
 * names must match `[A-Za-z0-9_-]`, so `file.write` comes back as `file_write`,
 * and older checkpoints can still carry `file_write__<hash>` wire names. Models
 * also carry short names from other harnesses (`write`, `read`). Matching only
 * the exact string turns those harmless variants into a failed call plus a
 * wasted round trip, so callers resolve through this module instead.
 *
 * Only syntactic variants and the explicit compatibility vocabulary below are
 * resolved. Ambiguous names stay unresolved: silently executing a different
 * tool than the model asked for is worse than returning the exact candidates.
 */

export type ToolNameMatchBasis = "exact" | "canonical" | "alias";

export interface ToolNameMatch {
  toolId: string;
  basis: ToolNameMatchBasis;
}

export interface ToolNameResolution {
  match: ToolNameMatch | null;
  /** Available runtime IDs ranked by similarity, for corrective feedback. */
  suggestions: string[];
}

/** Wire names produced for IDs that providers cannot accept verbatim. */
const WIRE_HASH_SUFFIX = /__[0-9a-f]{16}$/;
/** JSON-schema/function wrappers some providers prepend to function names. */
const TOOL_NAMESPACE_PREFIX = /^(?:functions?|tools?)[._:]/;
const SUGGESTION_LIMIT = 5;
/** Below this similarity an ID is noise rather than a plausible candidate. */
const SUGGESTION_THRESHOLD = 0.4;

/**
 * Compatibility vocabulary for models that call the harness with the names of
 * another agent product. Keys are canonical names (see `canonicalToolName`),
 * values are this runtime's IDs. Never grow this with fuzzy or semantic
 * guesses; add a name only when it unambiguously denotes one tool.
 */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  read: "file.read",
  read_file: "file.read",
  view: "file.read",
  view_file: "file.read",
  write: "file.write",
  write_file: "file.write",
  create_file: "file.write",
  save_file: "file.write",
  edit: "file.patch",
  edit_file: "file.patch",
  str_replace: "file.patch",
  str_replace_editor: "file.patch",
  apply_patch: "file.patch",
  ls: "file.list",
  list_dir: "file.list",
  list_files: "file.list",
  glob: "file.glob",
  find_files: "file.glob",
  grep: "rg",
  grep_search: "rg",
  search_files: "rg",
  delete_file: "file.delete",
  remove_file: "file.delete",
  shell: "bash",
  run_command: "bash",
  run_terminal_cmd: "bash",
  terminal: "bash",
  exec: "bash",
  web_search: "webSearch",
  search_web: "webSearch",
  python: "python.run",
  run_python: "python.run",
};

/**
 * Case, separator, namespace and wire-hash insensitive form of a tool name.
 * `functions.file.write`, `File.Write`, `file_write` and
 * `file_write__0123456789abcdef` all canonicalize to `file_write`.
 */
export function canonicalToolName(name: string): string {
  let value = name.trim().replace(WIRE_HASH_SUFFIX, "");
  while (TOOL_NAMESPACE_PREFIX.test(value))
    value = value.replace(TOOL_NAMESPACE_PREFIX, "");
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Resolve `name` against the IDs available to one session.
 *
 * Order: exact ID, unique canonical form, unique compatibility alias. When
 * none applies the returned suggestions name real tools so the caller can tell
 * the model what exists instead of leaving it to guess again.
 */
export function resolveToolName(
  name: string,
  availableIds: Iterable<string>,
): ToolNameResolution {
  const available = [...new Set(availableIds)].filter(Boolean);
  if (available.includes(name)) {
    return { match: { toolId: name, basis: "exact" }, suggestions: [] };
  }

  const key = canonicalToolName(name);
  if (!key) return { match: null, suggestions: suggest(key, available) };

  const byCanonical = new Map<string, string[]>();
  for (const id of available) {
    const canonical = canonicalToolName(id);
    if (!canonical) continue;
    const ids = byCanonical.get(canonical);
    if (ids) ids.push(id);
    else byCanonical.set(canonical, [id]);
  }

  const canonicalMatches = byCanonical.get(key) ?? [];
  if (canonicalMatches.length === 1) {
    return {
      match: { toolId: canonicalMatches[0], basis: "canonical" },
      suggestions: [],
    };
  }

  const alias = uniqueAliasTarget(key, available);
  if (alias) return { match: { toolId: alias, basis: "alias" }, suggestions: [] };

  // Ambiguous canonical forms are the most useful candidates; keep them first.
  const suggestions = [
    ...canonicalMatches,
    ...suggest(key, available).filter((id) => !canonicalMatches.includes(id)),
  ].slice(0, SUGGESTION_LIMIT);
  return { match: null, suggestions };
}

/**
 * An alias resolves only when nothing else in the session could have been
 * meant by the same word, e.g. a mounted `mcp.docs.write` blocks `write`.
 */
function uniqueAliasTarget(key: string, available: string[]): string | null {
  const target = TOOL_ALIASES[key];
  if (!target || !available.includes(target)) return null;
  // A mounted MCP server can expose the same bare word (`mcp.docs.write`).
  // Core tools such as `design.write` are distinct capabilities, not rivals.
  const competitor = available.some((id) => {
    if (id === target || !id.startsWith("mcp.")) return false;
    const canonical = canonicalToolName(id);
    return canonical === key || canonical.endsWith(`_${key}`);
  });
  return competitor ? null : target;
}

function suggest(key: string, available: string[]): string[] {
  // A missing name carries no signal, so offer a bounded sample of real tools.
  if (!key)
    return [...available].sort().slice(0, SUGGESTION_LIMIT);
  const ranked = available
    .map((id) => {
      const canonical = canonicalToolName(id);
      return { id, overlap: tokenOverlap(key, canonical), closeness: closeness(key, canonical) };
    })
    .filter(
      (entry) =>
        entry.overlap >= SUGGESTION_THRESHOLD ||
        entry.closeness >= SUGGESTION_THRESHOLD,
    )
    .toSorted(
      (a, b) =>
        b.overlap - a.overlap ||
        b.closeness - a.closeness ||
        a.id.localeCompare(b.id),
    )
    .slice(0, SUGGESTION_LIMIT)
    .map((entry) => entry.id);
  // A near-verbatim typo has one right answer; listing neighbours would invite
  // another guess. Otherwise show the ranked candidates.
  const best = ranked[0] ? closeness(key, canonicalToolName(ranked[0])) : 0;
  return best >= 0.75 ? ranked.slice(0, 1) : ranked;
}

function tokenOverlap(left: string, right: string): number {
  if (!left || !right) return 0;
  const leftTokens = new Set(left.split("_").filter(Boolean));
  const rightTokens = new Set(right.split("_").filter(Boolean));
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return (2 * shared) / (leftTokens.size + rightTokens.size);
}

function closeness(left: string, right: string): number {
  if (!left || !right) return 0;
  const longest = Math.max(left.length, right.length);
  const distance = editDistance(left, right, 2);
  return distance > 2 ? 0 : 1 - distance / longest;
}

/** Bounded Levenshtein distance: anything above `limit` is reported as +1. */
function editDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    let best = row;
    for (let column = 1; column <= right.length; column++) {
      const substitution =
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      const value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        substitution,
      );
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}
