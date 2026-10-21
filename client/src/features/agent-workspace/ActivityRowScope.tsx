import { createContext, useContext, type ReactNode } from "react";

/**
 * Rows inside a live process window are one line each.
 *
 * The window keeps a fixed number of rows and follows the newest one, so its
 * rows must all share one height: a row that opened its body would grow out of
 * that budget and push its neighbours around. The window therefore renders
 * every row inside this scope and the records drop their disclosure while they
 * are in it. A finished turn lays the same rows out without the scope, so the
 * detail stays reachable once the record stops moving.
 */
const CompactActivityRow = createContext(false);

export function ActivityRowScope({
  compact,
  children,
}: {
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <CompactActivityRow.Provider value={compact}>{children}</CompactActivityRow.Provider>
  );
}

/** True when the row is rendered inside a live process window. */
export function useCompactActivityRow(): boolean {
  return useContext(CompactActivityRow);
}
