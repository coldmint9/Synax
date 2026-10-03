export interface ContextMenuAction {
  type: "action";
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  /** Leave focus to a dialog opened by this action. */
  restoreFocus?: boolean;
  run: () => void | Promise<void>;
}

export interface ContextMenuSeparator {
  type: "separator";
}

export type ContextMenuEntry = ContextMenuAction | ContextMenuSeparator;

export interface ContextMenuDefinition {
  label: string;
  entries: ContextMenuEntry[];
}

export interface NativeContextMenuAction {
  type: "action";
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}
export type NativeContextMenuEntry = NativeContextMenuAction | ContextMenuSeparator;

export function nativeMenuEntries(entries: ContextMenuEntry[]): NativeContextMenuEntry[] {
  return entries.map((entry) => entry.type === "separator"
    ? { type: "separator" }
    : { type: "action", id: entry.id, label: entry.label, disabled: entry.disabled, danger: entry.danger });
}
