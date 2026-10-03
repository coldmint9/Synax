import { useCallback, useMemo, type SetStateAction } from "react";
import { create } from "zustand";

/** Setters stay bound to their originating draft, including async callbacks. */
export function createScopedDraftState<T>() {
  const store = create<{ values: Record<string, T> }>(() => ({ values: {} }));
  function useDraft(scope: string, initialize: () => T) {
    // A scope change must select the new value during render, not after paint.
    const initial = useMemo(initialize, [scope]);
    const value = store((state) => state.values[scope] ?? initial);
    const read = useCallback(
      () => store.getState().values[scope] ?? initial,
      [scope, initial],
    );
    const set = useCallback(
      (next: SetStateAction<T>) => {
        store.setState((state) => ({
          values: {
            ...state.values,
            [scope]:
              typeof next === "function"
                ? (next as (previous: T) => T)(state.values[scope] ?? initial)
                : next,
          },
        }));
      },
      [scope, initial],
    );
    return [value, set, read] as const;
  }
  return { useDraft, reset: () => store.setState({ values: {} }) };
}
