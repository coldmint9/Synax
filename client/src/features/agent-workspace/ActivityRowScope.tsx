import { createContext, useContext, type ReactNode } from "react";

/**
 * Rows inside a live process window are one line each.
 *
 * The window keeps a fixed number of rows and follows the newest one, so its
 * rows must all share one height: a row that opened its body would grow out of
 * that budget and push its neighbours around. The window therefore renders
 * every row inside this scope, which reports the fixed row height.
 *
 * Rows keep their disclosure affordance: activating a record hands the window
 * to the reader (`useActivityWindowTakeOver`), the window stops following the
 * newest record, and the same rows lay out at their natural height. A finished
 * turn renders the rows without the scope from the start.
 */
const CompactActivityRow = createContext(false);
const TakeOverActivityWindow = createContext<(() => void) | null>(null);

export function ActivityRowScope({
  compact,
  onTakeOver,
  children,
}: {
  compact: boolean;
  onTakeOver?: () => void;
  children: ReactNode;
}) {
  return (
    <CompactActivityRow.Provider value={compact}>
      <TakeOverActivityWindow.Provider value={onTakeOver ?? null}>
        {children}
      </TakeOverActivityWindow.Provider>
    </CompactActivityRow.Provider>
  );
}

/** True when the row is rendered inside a live process window. */
export function useCompactActivityRow(): boolean {
  return useContext(CompactActivityRow);
}

/**
 * Stop the surrounding live window from following the newest record.
 *
 * Null outside a live window: a finished turn needs no take-over because its
 * rows already lay out in place.
 */
export function useActivityWindowTakeOver(): (() => void) | null {
  return useContext(TakeOverActivityWindow);
}
