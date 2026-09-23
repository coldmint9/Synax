import { copyTextToClipboard } from "../../../lib/clipboard";
import { useNotificationStore } from "../../state/notificationStore";
import type { ContextMenuEntry } from "../../components/context-menu/types";
import type { useLocale } from "../../../hooks/useLocale";

type Translate = ReturnType<typeof useLocale>["t"];
interface RevealApi { revealWorkspaceFile?: (root: string, path: string) => Promise<boolean> }
const desktop = () => (window as Window & { electronAPI?: RevealApi }).electronAPI;

export function absoluteWorkspacePath(root: string, relative: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relative.replace(/[\\/]/g, separator)}`;
}

async function copy(value: string, t: Translate) {
  if (!await copyTextToClipboard(value)) throw new Error(t("contextCopyFailed"));
  useNotificationStore.getState().push({ type: "success", message: t("contextCopied"), duration: 1800 });
}

export function fileContextEntries({
  t, path, workspacePath, onOpen, onDiff, onRevert, canOpenFile = true,
  canRevert = false, busy = false,
}: {
  t: Translate;
  path: string;
  workspacePath?: string;
  onOpen?: () => void;
  onDiff?: () => void;
  onRevert?: () => void;
  canOpenFile?: boolean;
  canRevert?: boolean;
  busy?: boolean;
}): ContextMenuEntry[] {
  const items: ContextMenuEntry[] = [];
  if (onDiff) items.push({ type: "action", id: "diff", label: t("contextOpenDiff"), run: onDiff });
  if (onOpen && canOpenFile) items.push({ type: "action", id: "open", label: t("contextOpenFile"), run: onOpen });
  if (items.length) items.push({ type: "separator" });
  items.push({ type: "action", id: "copy-relative", label: t("contextCopyRelativePath"), run: () => copy(path, t) });
  if (workspacePath) items.push({ type: "action", id: "copy-absolute", label: t("contextCopyAbsolutePath"), run: () => copy(absoluteWorkspacePath(workspacePath, path), t) });
  if (workspacePath && canOpenFile && desktop()?.revealWorkspaceFile) {
    items.push({ type: "action", id: "reveal", label: t("contextRevealFile"), run: async () => {
      const ok = await desktop()!.revealWorkspaceFile!(workspacePath, path);
      if (!ok) throw new Error(t("contextRevealFailed"));
    } });
  }
  if (canRevert && onRevert) items.push({ type: "separator" }, {
    type: "action", id: "revert", label: t("workspaceRevertFile"), danger: true, disabled: busy, restoreFocus: false, run: onRevert,
  });
  return items;
}

export function sourceContextEntries({ t, label, path, workspacePath, onOpen }: {
  t: Translate; label: string; path?: string; workspacePath?: string; onOpen: () => void;
}): ContextMenuEntry[] {
  if (path) return fileContextEntries({ t, path, workspacePath, onOpen });
  return [{ type: "action", id: "open", label: t("contextOpenSource"), run: onOpen },
    { type: "separator" },
    { type: "action", id: "copy-source", label: t("contextCopySource"), run: () => copy(label, t) }];
}

