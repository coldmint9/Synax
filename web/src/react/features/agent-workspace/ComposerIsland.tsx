import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ChevronUp, Loader2, Square } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";

export function ComposerIsland({
  sessionId,
  running,
  readingHistory,
  protectedInteraction,
  onStop,
  children,
}: {
  sessionId?: string;
  running: boolean;
  readingHistory: boolean;
  protectedInteraction: boolean;
  onStop: () => void;
  children: ReactNode;
}) {
  const { locale } = useLocale(),
    zh = locale === "zh";
  const hostRef = useRef<HTMLDivElement>(null);
  const initialSession = useRef(sessionId);
  const [entranceFinished, setEntranceFinished] = useState(false);
  useLayoutEffect(() => {
    if (initialSession.current !== sessionId) setEntranceFinished(true);
  }, [sessionId]);
  const contentRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [settledSession, setSettledSession] = useState<{ id?: string } | null>(
    null,
  );
  const switching = !settledSession || settledSession.id !== sessionId;
  // Keep transitions off through layout measurement and the first painted frame.
  useLayoutEffect(() => {
    setSettledSession(null);
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() =>
        setSettledSession({ id: sessionId }),
      );
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [sessionId]);
  const [focused, setFocused] = useState(false);
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  useEffect(() => {
    setManuallyExpanded(false);
  }, [sessionId, running, readingHistory]);
  useLayoutEffect(() => {
    const host = hostRef.current,
      content = contentRef.current;
    if (!host || !content) return;
    const measure = () => {
      const width = host.clientWidth;
      const height = content.scrollHeight;
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(host);
    observer?.observe(content);
    return () => observer?.disconnect();
  }, [sessionId]);
  const collapsed =
    running &&
    readingHistory &&
    !protectedInteraction &&
    !focused &&
    !(manuallyExpanded && !switching);
  const expand = () => {
    setManuallyExpanded(true);
    // Do not focus the offscreen textarea or change the reader's scroll position.
  };
  return (
    <div
      ref={hostRef}
      className={`session-composer-island${!entranceFinished ? " animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none" : ""}`}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setEntranceFinished(true);
      }}
      data-switching={switching ? "true" : undefined}
      data-collapsed={collapsed ? "true" : "false"}
      style={
        {
          "--composer-island-width": `${size.width}px`,
          "--composer-island-height": `${size.height}px`,
        } as CSSProperties
      }
    >
      <div
        className="session-composer-island-frame"
        data-measured={size.width && size.height ? "true" : undefined}
      >
        <div
          ref={contentRef}
          className="session-composer-island-content"
          aria-hidden={collapsed || undefined}
          inert={collapsed}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setFocused(false);
          }}
        >
          {children}
        </div>
        <div
          className="session-composer-island-pill"
          aria-hidden={!collapsed || undefined}
          inert={!collapsed}
        >
          <button
            type="button"
            className="session-composer-island-expand"
            aria-label={zh ? "展开输入框" : "Expand composer"}
            aria-expanded={!collapsed}
            onClick={expand}
          >
            <Loader2
              size={14}
              className="session-composer-island-spinner"
              aria-hidden
            />
            <span>{zh ? "运行中" : "Running"}</span>
            <ChevronUp size={13} aria-hidden />
          </button>
          <button
            type="button"
            className="session-composer-island-stop"
            aria-label={zh ? "停止" : "Stop"}
            onClick={onStop}
          >
            <Square size={11} fill="currentColor" />
          </button>
        </div>
      </div>
    </div>
  );
}
