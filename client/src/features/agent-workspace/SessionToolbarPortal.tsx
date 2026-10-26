import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const SessionToolbarContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
  actionsTarget: HTMLDivElement | null;
  setActionsTarget: (target: HTMLDivElement | null) => void;
}>({
  target: null,
  setTarget: () => {},
  actionsTarget: null,
  setActionsTarget: () => {},
});

/** Keep sidebar actions with their page state while hosting them in the header. */
export function SessionToolbarProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const value = useMemo(
    () => ({ target, setTarget, actionsTarget, setActionsTarget }),
    [target, actionsTarget],
  );
  return (
    <SessionToolbarContext.Provider value={value}>
      {children}
    </SessionToolbarContext.Provider>
  );
}

export function SessionToolbarTarget() {
  const { setTarget } = useContext(SessionToolbarContext);
  return <div ref={setTarget} className="workbench-header__sidebar-target" />;
}

export function SessionToolbarContent({ children }: { children: ReactNode }) {
  const { target } = useContext(SessionToolbarContext);
  return target ? createPortal(children, target) : null;
}

export function SessionToolbarActionsTarget() {
  const { setActionsTarget } = useContext(SessionToolbarContext);
  return (
    <div ref={setActionsTarget} className="workbench-header__actions-target" />
  );
}

export function SessionToolbarActionsContent({
  children,
}: {
  children: ReactNode;
}) {
  const { actionsTarget } = useContext(SessionToolbarContext);
  return actionsTarget ? createPortal(children, actionsTarget) : null;
}
