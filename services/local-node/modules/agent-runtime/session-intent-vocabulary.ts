import { agentRuntimeStore } from "./session-store.js";
import { normalizeIntentCategory } from "./session-classification.js";

/** How many labels one title prompt may list. */
export const MAX_PROMPT_LABELS = 20;

interface IntentLabelUsage {
  label: string;
  uses: number;
  lastUsedAt: string;
}

/**
 * Labels ordered by how much the workspace already relies on them: the most
 * reused first, most recent first within a tie.
 *
 * Handing that order to the model is what keeps a taxonomy from growing a new
 * synonym per session — the labels it sees first are the ones it copies.
 */
export function rankIntentLabels(
  entries: Array<{ label: string; updatedAt: string }>,
  limit = MAX_PROMPT_LABELS,
): string[] {
  const usage = new Map<string, IntentLabelUsage>();
  for (const entry of entries) {
    const label = normalizeIntentCategory(entry.label);
    if (!label) continue;
    const known = usage.get(label);
    if (!known) {
      usage.set(label, { label, uses: 1, lastUsedAt: entry.updatedAt });
      continue;
    }
    known.uses += 1;
    if (entry.updatedAt > known.lastUsedAt) known.lastUsedAt = entry.updatedAt;
  }
  return [...usage.values()]
    .sort(
      (a, b) =>
        b.uses - a.uses ||
        b.lastUsedAt.localeCompare(a.lastUsedAt) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, limit)
    .map((entry) => entry.label);
}

/**
 * Labels this workspace has already published.
 *
 * A read-only projection taken once per generation, so it stays on the same
 * workspace the session list groups: a label invented in another workspace is
 * not what this list needs to converge on.
 */
export function listWorkspaceIntentLabels(
  projectId: string,
  limit = MAX_PROMPT_LABELS,
): string[] {
  if (!projectId) return [];
  const entries: Array<{ label: string; updatedAt: string }> = [];
  try {
    for (const session of agentRuntimeStore.listSessions({
      projectId,
      limit: Infinity,
    })) {
      const label = session.sessionMetadata?.intentCategory;
      if (typeof label === "string")
        entries.push({ label, updatedAt: session.updatedAt });
    }
  } catch {
    // A vocabulary is an optimisation: an unreadable index must never cost a title.
    return [];
  }
  return rankIntentLabels(entries, limit);
}

function labelKey(label: string): string {
  return normalizeIntentCategory(label)?.toLocaleLowerCase().replace(/\s+/g, "") ??
    "";
}

/**
 * Snap a model answer onto the workspace's existing spelling.
 *
 * Semantic near-misses are the prompt's job; this only removes the mechanical
 * duplicates (case, spacing, trailing punctuation) that would otherwise split
 * one category into several list groups.
 */
export function reuseKnownIntentLabel(
  label: string,
  knownLabels: string[],
): string {
  const key = labelKey(label);
  if (!key) return label;
  return knownLabels.find((candidate) => labelKey(candidate) === key) ?? label;
}
