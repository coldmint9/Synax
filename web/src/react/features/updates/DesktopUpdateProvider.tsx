import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getDesktopUpdatesApi,
  type UpdaterState,
} from "../../../lib/desktop-updates";

interface DesktopUpdateContextValue {
  state: UpdaterState | null;
  error: string | null;
  requesting: boolean;
  visible: boolean;
  minimized: boolean;
  setMinimized(value: boolean): void;
  check(): Promise<void>;
  install(): Promise<void>;
}

const DesktopUpdateContext = createContext<DesktopUpdateContextValue | null>(
  null,
);
export const useDesktopUpdate = () => useContext(DesktopUpdateContext);

export function DesktopUpdateProvider({ children }: { children: ReactNode }) {
  const api = getDesktopUpdatesApi();
  const [state, setState] = useState<UpdaterState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [visible, setVisible] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    if (!api) return;
    let active = true;
    let received = false;
    const accept = (next: UpdaterState | null) => {
      if (!active) return;
      setState(next);
      setError(null);
      if (next && !["idle", "current", "complete"].includes(next.phase))
        setVisible(true);
    };
    // Subscribe first: a slow initial snapshot must not overwrite newer progress.
    const offState = api.onDesktopUpdateState((next) => {
      received = true;
      accept(next);
    });
    const offShow = api.onDesktopUpdateShow(() => {
      setVisible(true);
      setMinimized(false);
    });
    void api
      .getDesktopUpdateState()
      .then((next) => {
        if (!received) accept(next);
      })
      .catch((error) => {
        if (active && !received)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
      offState();
      offShow();
    };
  }, [api]);

  const run = useCallback(
    async (action: "check" | "install") => {
      if (!api || pending.current) return;
      pending.current = true;
      setRequesting(true);
      setError(null);
      setVisible(true);
      setMinimized(false);
      try {
        await (action === "check"
          ? api.checkDesktopUpdate()
          : api.installDesktopUpdate());
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        pending.current = false;
        setRequesting(false);
      }
    },
    [api],
  );

  return (
    <DesktopUpdateContext.Provider
      value={{
        state,
        error,
        requesting,
        visible,
        minimized,
        setMinimized,
        check: () => run("check"),
        install: () => run("install"),
      }}
    >
      {children}
    </DesktopUpdateContext.Provider>
  );
}
