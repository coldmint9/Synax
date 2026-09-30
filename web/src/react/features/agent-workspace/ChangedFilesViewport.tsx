import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Rows shown at once before the changed-file list starts scrolling. */
export const CHANGED_FILES_VISIBLE_ROWS = 8;

interface ViewportState {
  scrollable: boolean;
  atBottom: boolean;
}

const INITIAL_STATE: ViewportState = { scrollable: false, atBottom: true };

/**
 * Content-sized scrollport for Git changes: the body keeps its natural height
 * until it would show more than {@link CHANGED_FILES_VISIBLE_ROWS} rows, then it
 * caps and scrolls with a bottom fade hinting at the rows still below.
 */
export function ChangedFilesViewport({
  ariaLabel,
  children,
}: {
  ariaLabel: string;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(0);
  const [state, setState] = useState<ViewportState>(INITIAL_STATE);

  const sync = useCallback(() => {
    const node = viewport.current;
    if (!node) return;
    const first = rows.current?.firstElementChild;
    const measured = first ? first.getBoundingClientRect().height : 0;
    if (measured > 0) {
      setRowHeight((current) =>
        Math.abs(current - measured) < 0.5 ? current : measured,
      );
    }
    const scrollable = node.scrollHeight - node.clientHeight > 1;
    const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
    setState((current) =>
      current.scrollable === scrollable && current.atBottom === atBottom
        ? current
        : { scrollable, atBottom },
    );
  }, []);

  // Layout can change without the port resizing, so this runs after each render.
  useLayoutEffect(() => {
    sync();
  });

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    if (viewport.current) observer.observe(viewport.current);
    if (rows.current) observer.observe(rows.current);
    return () => observer.disconnect();
  }, [sync]);

  // Without measured layout (tests, first paint) the list keeps its natural height.
  const maxHeight =
    rowHeight > 0 ? rowHeight * CHANGED_FILES_VISIBLE_ROWS : undefined;

  return (
    <div className="ws-changes-viewport">
      <div
        className="ws-changes-scroll"
        ref={viewport}
        role="group"
        aria-label={ariaLabel}
        tabIndex={0}
        style={maxHeight === undefined ? undefined : { maxHeight }}
        onScroll={sync}
      >
        <div className="ws-changes-rows" ref={rows}>
          {children}
        </div>
      </div>
      <div
        className="ws-changes-fade"
        data-visible={state.scrollable && !state.atBottom ? "true" : "false"}
        aria-hidden="true"
      />
    </div>
  );
}
