import fs from "node:fs";
import path from "node:path";
import type { MenuItemConstructorOptions } from "electron";

export type ContextEntry =
  | { type: "action"; id: string; label: string; disabled?: boolean; danger?: boolean }
  | { type: "separator" };

const idPattern = /^[\w:.-]{1,100}$/;
export function parseContextMenu(value: unknown): { requestId: string; x: number; y: number; entries: ContextEntry[] } | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data.requestId !== "string" || !idPattern.test(data.requestId)
    || typeof data.x !== "number" || !Number.isFinite(data.x)
    || typeof data.y !== "number" || !Number.isFinite(data.y)
    || !Array.isArray(data.entries) || data.entries.length === 0 || data.entries.length > 40) return null;
  const entries: ContextEntry[] = [];
  const seen = new Set<string>();
  for (const raw of data.entries) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (item.type === "separator") { entries.push({ type: "separator" }); continue; }
    if (item.type !== "action" || typeof item.id !== "string" || !idPattern.test(item.id)
      || seen.has(item.id) || typeof item.label !== "string"
      || !item.label.trim() || item.label.length > 120 || /[\x00-\x1f\x7f]/.test(item.label)
      || (item.disabled !== undefined && typeof item.disabled !== "boolean")
      || (item.danger !== undefined && typeof item.danger !== "boolean")) return null;
    seen.add(item.id);
    entries.push({ type: "action", id: item.id, label: item.label, disabled: item.disabled, danger: item.danger });
  }
  return seen.size ? { requestId: data.requestId, x: data.x, y: data.y, entries } : null;
}

export function nativeTemplate(entries: ContextEntry[], onAction: (id: string) => void): MenuItemConstructorOptions[] {
  return entries.map((entry) => entry.type === "separator"
    ? { type: "separator" }
    : { id: entry.id, label: entry.label, enabled: !entry.disabled, click: () => onAction(entry.id) });
}

/** Native text editing is separate from application-specific context menus. */
export function textContextTemplate(isEditable: boolean, hasSelection: boolean): MenuItemConstructorOptions[] | null {
  if (isEditable) return [
    { role: "undo" }, { role: "redo" }, { type: "separator" },
    { role: "cut" }, { role: "copy" }, { role: "paste" },
    { type: "separator" }, { role: "selectAll" },
  ];
  return hasSelection ? [{ role: "copy" }] : null;
}

/** The renderer supplies a workspace root, but cannot escape that root via relative paths or symlinks. */
export function resolveRevealTarget(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const { workspacePath, relativePath } = value as Record<string, unknown>;
  if (typeof workspacePath !== "string" || typeof relativePath !== "string"
    || !path.isAbsolute(workspacePath) || !relativePath || path.isAbsolute(relativePath)
    || relativePath.includes("\0") || workspacePath.includes("\0")) return null;
  try {
    const root = fs.realpathSync(workspacePath);
    if (!fs.statSync(root).isDirectory()) return null;
    const target = path.resolve(root, relativePath);
    const rel = path.relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    const realTarget = fs.realpathSync(target);
    const realRel = path.relative(root, realTarget);
    if (!realRel || realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)
      || !fs.statSync(realTarget).isFile()) return null;
    return realTarget;
  } catch { return null; }
}
