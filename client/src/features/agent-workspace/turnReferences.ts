import { Bot, FileText, Plug, Sparkles, type LucideIcon } from "lucide-react";
import type { TurnReference } from "../../adapters/transport/agentRuntime";

/** Reference kinds a turn can select; kept in schema order of the runtime. */
export const TURN_REFERENCE_KINDS = [
  "skill",
  "mcp",
  "file",
  "subagent",
] as const;

interface TurnReferencePresenter {
  Icon: LucideIcon;
  zh: string;
  en: string;
}

const presenters: Record<TurnReference["kind"], TurnReferencePresenter> = {
  skill: { Icon: Sparkles, zh: "技能", en: "Skill" },
  mcp: { Icon: Plug, zh: "MCP", en: "MCP" },
  file: { Icon: FileText, zh: "文件", en: "File" },
  subagent: { Icon: Bot, zh: "子代理", en: "Subagent" },
};

export function turnReferenceIcon(kind: TurnReference["kind"]): LucideIcon {
  return presenters[kind].Icon;
}

export function turnReferenceKindLabel(
  kind: TurnReference["kind"],
  zh: boolean,
): string {
  return zh ? presenters[kind].zh : presenters[kind].en;
}

/**
 * References arrive from persisted message metadata, so the shape is untrusted
 * history rather than a typed payload. Unknown kinds and duplicates are
 * dropped; the transcript must never fail to render because of bad metadata.
 */
export function readTurnReferences(value: unknown): TurnReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const references: TurnReference[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { kind, id, label } = entry as {
      kind?: unknown;
      id?: unknown;
      label?: unknown;
    };
    if (typeof id !== "string" || !id) continue;
    if (!TURN_REFERENCE_KINDS.includes(kind as TurnReference["kind"])) continue;
    const key = `${String(kind)}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({
      kind: kind as TurnReference["kind"],
      id,
      ...(typeof label === "string" && label ? { label } : {}),
    });
  }
  return references;
}
