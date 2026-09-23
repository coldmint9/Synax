import { Dropdown, Label, Separator } from "@heroui/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { handleError } from "../../../lib/errors";
import { nativeMenuEntries, type ContextMenuDefinition, type NativeContextMenuEntry } from "./types";

interface DesktopContextMenuApi {
  showContextMenu: (request: {
    requestId: string;
    x: number;
    y: number;
    entries: NativeContextMenuEntry[];
  }) => Promise<boolean>;
  onContextMenuAction: (callback: (requestId: string, actionId: string) => void) => () => void;
  onContextMenuClosed: (callback: (requestId: string) => void) => () => void;
}

function desktopApi(): DesktopContextMenuApi | undefined {
  return (window as Window & { electronAPI?: Partial<DesktopContextMenuApi> }).electronAPI as DesktopContextMenuApi | undefined;
}

interface OpenMenu {
  definition: ContextMenuDefinition;
  requestId: string;
  point: { x: number; y: number };
  trigger: HTMLElement;
}
interface MenuContext {
  open: (definition: ContextMenuDefinition, point: { x: number; y: number }, trigger: HTMLElement) => void;
}
const Context = createContext<MenuContext | null>(null);

function preservesNativeMenu(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (element?.closest('input, textarea, [contenteditable=""], [contenteditable="true"], .code-viewer-content, .diff-viewer-body')) return true;
  const selection = window.getSelection();
  return Boolean(selection?.toString() && selection.anchorNode && element?.contains(selection.anchorNode));
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<OpenMenu | null>(null);
  const pending = useRef<OpenMenu | null>(null);
  const location = useLocation();
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });

  const close = useCallback((restore = true) => {
    const previous = pending.current;
    pending.current = null;
    setCurrent(null);
    if (restore && previous?.trigger.isConnected) {
      requestAnimationFrame(() => previous.trigger.isConnected && previous.trigger.focus());
    }
  }, []);

  useEffect(() => { close(false); }, [location.key, close]);
  useEffect(() => {
    const api = desktopApi();
    if (!api?.onContextMenuAction || !api.onContextMenuClosed) return;
    const offAction = api.onContextMenuAction((requestId, actionId) => {
      const menu = pending.current;
      if (!menu || menu.requestId !== requestId) return;
      const action = menu.definition.entries.find((item) => item.type === "action" && item.id === actionId);
      if (!action || action.type !== "action" || action.disabled) return;
      close(action.restoreFocus !== false);
      try { void Promise.resolve(action.run()).catch(handleError); } catch (error) { handleError(error); }
    });
    const offClosed = api.onContextMenuClosed((requestId) => {
      if (pending.current?.requestId === requestId) close();
    });
    return () => { offAction(); offClosed(); };
  }, [close]);

  const open = useCallback((definition: ContextMenuDefinition, point: { x: number; y: number }, trigger: HTMLElement) => {
    if (!definition.entries.some((item) => item.type === "action")) return;
    const request: OpenMenu = { definition, point, trigger, requestId: crypto.randomUUID() };
    pending.current = request;
    const api = desktopApi();
    if (api?.showContextMenu) {
      setCurrent(null);
      void api.showContextMenu({ requestId: request.requestId, x: point.x, y: point.y, entries: nativeMenuEntries(definition.entries) })
        .then((accepted) => { if (!accepted && pending.current?.requestId === request.requestId) close(); })
        .catch((error) => { if (pending.current?.requestId === request.requestId) close(); handleError(error); });
    } else {
      setAnchor(point);
      setCurrent(request);
    }
  }, [close]);

  const select = (actionId: string) => {
    const menu = pending.current;
    const action = menu?.definition.entries.find((item) => item.type === "action" && item.id === actionId);
    if (!action || action.type !== "action" || action.disabled) return;
    close(action.restoreFocus !== false);
    try { void Promise.resolve(action.run()).catch(handleError); } catch (error) { handleError(error); }
  };

  return (
    <Context.Provider value={{ open }}>
      {children}
      {current && (
        <Dropdown isOpen onOpenChange={(value) => { if (!value) close(); }}>
          <Dropdown.Trigger type="button" aria-label={current.definition.label} className="fixed pointer-events-none opacity-0 size-px" style={{ left: anchor.x, top: anchor.y }} />
          <Dropdown.Popover placement="bottom start" offset={0} className="synax-context-menu z-[10000] max-h-[min(26rem,calc(100vh-16px))] min-w-44 overflow-y-auto">
            <Dropdown.Menu aria-label={current.definition.label} onAction={(key) => select(String(key))}>
              {current.definition.entries.map((entry, index) => entry.type === "separator"
                ? <Separator key={`separator-${index}`} className="my-1" />
                : <Dropdown.Item key={entry.id} id={entry.id} textValue={entry.label} isDisabled={entry.disabled} variant={entry.danger ? "danger" : "default"}>
                    <Label>{entry.label}</Label>
                  </Dropdown.Item>)}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
    </Context.Provider>
  );
}

/** Bind only to explicit business rows. Text and selection keep their system menu. */
export function useContextMenu(definition: () => ContextMenuDefinition) {
  const context = useContext(Context);
  if (!context) throw new Error("ContextMenuProvider is missing");
  return {
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      if (preservesNativeMenu(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      context.open(definition(), { x: event.clientX, y: event.clientY }, event.currentTarget);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") || preservesNativeMenu(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      context.open(definition(), { x: rect.left, y: rect.bottom }, event.currentTarget);
    },
    openFromAnchor: (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      context.open(definition(), { x: rect.left, y: rect.bottom }, element);
    },
    "aria-haspopup": "menu" as const,
  };
}
