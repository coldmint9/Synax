import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const GitToolbarContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
}>({ target: null, setTarget: () => {} });

/** The Git page keeps ownership of its actions while the header hosts them. */
export function GitToolbarProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <GitToolbarContext.Provider value={{ target, setTarget }}>
      {children}
    </GitToolbarContext.Provider>
  );
}

export function GitToolbarTarget() {
  const { setTarget } = useContext(GitToolbarContext);
  return <div ref={setTarget} className="git-island-toolbar" />;
}

export function GitToolbarContent({ children }: { children: ReactNode }) {
  const { target } = useContext(GitToolbarContext);
  return target ? createPortal(children, target) : null;
}
