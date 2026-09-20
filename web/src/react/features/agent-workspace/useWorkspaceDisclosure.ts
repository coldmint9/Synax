import { useState } from "react";

/** A disclosure belongs to its repository/session, not the translated title. */
export function useWorkspaceDisclosure(
  key: string | undefined,
  defaultOpen = true,
) {
  const storageKey = key ? `synax:workspace:disclosure:${key}` : undefined;
  const read = () => {
    try {
      const saved = storageKey ? localStorage.getItem(storageKey) : null;
      return saved === null ? defaultOpen : saved === "true";
    } catch {
      return defaultOpen;
    }
  };
  const [state, setState] = useState(() => ({ key: storageKey, open: read() }));
  const open = state.key === storageKey ? state.open : read();
  const toggle = () => {
    const next = !open;
    setState({ key: storageKey, open: next });
    try {
      if (storageKey) localStorage.setItem(storageKey, String(next));
    } catch {
      /* Private browsing. */
    }
  };
  return [open, toggle] as const;
}
