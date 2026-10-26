import { createContext, useContext, type ReactNode } from "react";

/**
 * Rows inside a live process window are one line each.
 *
 * The window keeps a fixed number of rows and follows the newest one, so a
 * collapsed row must report the fixed row height. Only the record the reader
 * opens grows to its natural height: the row asks the window to expand it
 * (`useActivityRowExpansion`), and the window keeps every other row on the
 * fixed budget. Virtualization therefore stays on for the whole window instead
 * of dropping the disclosure of the opened record.
 */
const CompactActivityRow = createContext(false);
const ActiveActivityRow = createContext(true);
const ExpandActivityRow = createContext<(() => void) | null>(null);

export function ActivityRowScope({
  compact,
  active = true,
  onExpand,
  children,
}: {
  compact: boolean;
  /** True for the one record the window currently shows opened. */
  active?: boolean;
  onExpand?: () => void;
  children: ReactNode;
}) {
  return (
    <CompactActivityRow.Provider value={compact}>
      <ActiveActivityRow.Provider value={active}>
        <ExpandActivityRow.Provider value={onExpand ?? null}>
          {children}
        </ExpandActivityRow.Provider>
      </ActiveActivityRow.Provider>
    </CompactActivityRow.Provider>
  );
}

/** True when the row is rendered inside a live process window. */
export function useCompactActivityRow(): boolean {
  return useContext(CompactActivityRow);
}

/**
 * Open this row at its natural height inside the surrounding live window.
 *
 * Null outside a live window: a finished turn needs no request because its
 * rows already lay out in place.
 */
export function useActivityRowExpansion(): (() => void) | null {
  return useContext(ExpandActivityRow);
}

/**
 * True while this row is the one the live window shows opened. Only that row
 * keeps a disclosure body; every other row in the window stays one line, so
 * opening one record never unfolds its neighbours.
 */
export function useActivityRowActive(): boolean {
  return useContext(ActiveActivityRow);
}
