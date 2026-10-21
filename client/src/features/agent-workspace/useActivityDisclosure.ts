import { useState } from "react";

// History virtualization may unmount an open row. Retain only explicit reader
// choices, with a bound so long sessions cannot grow this cache indefinitely.
const expandedRows = new Map<string, boolean>();
const MAX_REMEMBERED_ROWS = 500;

export function useActivityDisclosure(rememberKey?: string, defaultExpanded = false) {
  const read = () => rememberKey ? expandedRows.get(rememberKey) ?? defaultExpanded : defaultExpanded;
  const [selection, setSelection] = useState<{ key: string | undefined; expanded: boolean } | null>(null);
  // Follow the live/finished default until the reader explicitly chooses.
  // Their choice still survives both completion and virtualization remounts.
  const expanded = selection && selection.key === rememberKey ? selection.expanded : read();

  const toggle = () => {
    const next = !expanded;
    if (rememberKey) {
      expandedRows.delete(rememberKey);
      expandedRows.set(rememberKey, next);
      if (expandedRows.size > MAX_REMEMBERED_ROWS) {
        expandedRows.delete(expandedRows.keys().next().value!);
      }
    }
    setSelection({ key: rememberKey, expanded: next });
  };
  return [expanded, toggle] as const;
}
