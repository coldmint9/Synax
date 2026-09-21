import type { TurnReference } from "../../../../lib/api/agentRuntime";
import type { RuntimeContentPart } from "../../../../lib/api/runtimeMedia";

const STORAGE_KEY = "synax.draftComposer";
const CONTEXT_KEY = "synax.draftComposerContext";

const REFERENCE_KINDS = new Set(["skill", "mcp", "file", "wiki"]);

/**
 * Per-project cache of the new-session composer text so a draft survives
 * navigating away (or a reload) before the session is created.
 */
function storageKey(projectId: string): string {
  return `${STORAGE_KEY}:${projectId}`;
}

function contextStorageKey(projectId: string): string {
  return `${CONTEXT_KEY}:${projectId}`;
}

export function loadDraftComposer(projectId: string): string {
  if (!projectId || typeof localStorage === "undefined") return "";
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return "";
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" ? parsed : "";
  } catch {
    return "";
  }
}

export function saveDraftComposer(projectId: string, content: string): void {
  if (!projectId || typeof localStorage === "undefined") return;
  try {
    if (content)
      localStorage.setItem(storageKey(projectId), JSON.stringify(content));
    else localStorage.removeItem(storageKey(projectId));
  } catch {
    /* quota */
  }
}

/** Attachment parts and context references cached alongside the draft text. */
export interface DraftComposerContext {
  parts: RuntimeContentPart[];
  references: TurnReference[];
}

function sanitizeParts(value: unknown): RuntimeContentPart[] {
  if (!Array.isArray(value)) return [];
  return value.filter((part): part is RuntimeContentPart => {
    if (typeof part !== "object" || part === null) return false;
    const candidate = part as RuntimeContentPart;
    return (
      typeof candidate.type === "string" &&
      candidate.type !== "text" &&
      "assetId" in candidate &&
      typeof candidate.assetId === "string"
    );
  });
}

function sanitizeReferences(value: unknown): TurnReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (reference): reference is TurnReference =>
      typeof reference === "object" &&
      reference !== null &&
      typeof (reference as TurnReference).id === "string" &&
      REFERENCE_KINDS.has((reference as TurnReference).kind),
  );
}

export function loadDraftComposerContext(
  projectId: string,
): DraftComposerContext {
  const empty: DraftComposerContext = { parts: [], references: [] };
  if (!projectId || typeof localStorage === "undefined") return empty;
  try {
    const raw = localStorage.getItem(contextStorageKey(projectId));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return empty;
    const record = parsed as Record<string, unknown>;
    return {
      parts: sanitizeParts(record.parts),
      references: sanitizeReferences(record.references),
    };
  } catch {
    return empty;
  }
}

export function saveDraftComposerContext(
  projectId: string,
  context: DraftComposerContext,
): void {
  if (!projectId || typeof localStorage === "undefined") return;
  try {
    if (context.parts.length || context.references.length)
      localStorage.setItem(
        contextStorageKey(projectId),
        JSON.stringify(context),
      );
    else localStorage.removeItem(contextStorageKey(projectId));
  } catch {
    /* quota */
  }
}

export function clearDraftComposer(projectId: string): void {
  if (!projectId || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(storageKey(projectId));
    localStorage.removeItem(contextStorageKey(projectId));
  } catch {
    /* ignore */
  }
}
