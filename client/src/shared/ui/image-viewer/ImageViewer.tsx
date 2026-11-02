import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from "@headlessui/react";
import { Download, Minus, Plus, RotateCcw, X } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useLocale } from "../../hooks/useLocale";
import "./imageViewer.css";

/** Multiples of the fitted size; 1 already fits the image inside the stage. */
const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6];
const MIN_ZOOM = ZOOM_LEVELS[0];
const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
const STAGE_PADDING = 32;

export interface ImageViewerProps {
  src: string;
  alt?: string;
  title?: string;
  /** Enables the download control when the viewer owns a named asset. */
  downloadName?: string;
  closeLabel?: string;
  onClose: () => void;
}

function nextZoom(current: number, direction: 1 | -1): number {
  if (direction === 1)
    return ZOOM_LEVELS.find((level) => level > current + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? MIN_ZOOM;
}

/**
 * Full-screen image preview with explicit zoom controls.
 *
 * The image starts fitted to the stage (100%), so opening a large screenshot
 * still shows the whole picture. Zoom multiplies that fitted size, the stage
 * scrolls once the picture outgrows it, and dragging pans the same way a
 * native image viewer does.
 */
export function ImageViewer({
  src,
  alt = "",
  title,
  downloadName,
  closeLabel,
  onClose,
}: ImageViewerProps) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ width: number; height: number }>();
  const [viewport, setViewport] = useState<{ width: number; height: number }>();
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const width = stage.clientWidth - STAGE_PADDING;
      const height = stage.clientHeight - STAGE_PADDING;
      if (width <= 0 || height <= 0) return;
      setViewport((previous) =>
        previous?.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const fittedWidth = useMemo(() => {
    if (!natural || !viewport) return undefined;
    return natural.width * Math.min(viewport.width / natural.width, viewport.height / natural.height, 1);
  }, [natural, viewport]);
  const width = fittedWidth === undefined ? undefined : Math.max(1, fittedWidth * zoom);
  const height = width === undefined || !natural ? undefined : width * (natural.height / natural.width);

  const zoomIn = useCallback(() => setZoom((current) => nextZoom(current, 1)), []);
  const zoomOut = useCallback(() => setZoom((current) => nextZoom(current, -1)), []);
  const resetZoom = useCallback(() => setZoom(1), []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomIn();
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomOut();
    } else if (event.key === "0") {
      event.preventDefault();
      resetZoom();
    }
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || zoom <= 1) return;
    const stage = event.currentTarget;
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: stage.scrollLeft,
      top: stage.scrollTop,
    };
    stage.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const stage = event.currentTarget;
    stage.scrollLeft = state.left - (event.clientX - state.x);
    stage.scrollTop = state.top - (event.clientY - state.y);
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const label = alt || title || (zh ? "图片预览" : "Image preview");

  return (
    <Dialog open onClose={onClose} className="image-viewer-root">
      <DialogBackdrop className="image-viewer-backdrop" />
      <DialogPanel
        className="image-viewer-panel"
        onKeyDown={onKeyDown}
        data-dragging={dragging || undefined}
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <div className="image-viewer-toolbar">
          <span className="image-viewer-title" title={label}>
            {label}
          </span>
          <div className="image-viewer-controls" role="toolbar" aria-label={zh ? "图片操作" : "Image controls"}>
            <button
              type="button"
              className="image-viewer-control"
              onClick={zoomOut}
              disabled={zoom <= MIN_ZOOM}
              aria-label={zh ? "缩小" : "Zoom out"}
              title={zh ? "缩小 (-)" : "Zoom out (-)"}
            >
              <Minus size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="image-viewer-zoom"
              onClick={resetZoom}
              title={zh ? "当前缩放（点击适应窗口）" : "Current zoom (click to fit)"}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="image-viewer-control"
              onClick={zoomIn}
              disabled={zoom >= MAX_ZOOM}
              aria-label={zh ? "放大" : "Zoom in"}
              title={zh ? "放大 (+)" : "Zoom in (+)"}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="image-viewer-control"
              onClick={resetZoom}
              disabled={zoom === 1}
              aria-label={zh ? "适应窗口" : "Fit to window"}
              title={zh ? "适应窗口 (0)" : "Fit to window (0)"}
            >
              <RotateCcw size={14} aria-hidden="true" />
            </button>
            {downloadName && (
              <a
                className="image-viewer-control"
                href={src}
                download={downloadName}
                aria-label={zh ? `下载 ${downloadName}` : `Download ${downloadName}`}
                title={zh ? "下载" : "Download"}
              >
                <Download size={15} aria-hidden="true" />
              </a>
            )}
            <button
              autoFocus
              type="button"
              className="image-viewer-control"
              onClick={onClose}
              aria-label={closeLabel ?? (zh ? "关闭图片预览" : "Close image preview")}
              title={zh ? "关闭 (Esc)" : "Close (Esc)"}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div
          ref={stageRef}
          className="image-viewer-stage"
          data-zoomed={zoom > 1 || undefined}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={(event) => {
            if (zoom === 1 && event.target === event.currentTarget) onClose();
          }}
          onDoubleClick={() => setZoom((current) => (current === 1 ? 2 : 1))}
        >
          <img
            className="image-viewer-image"
            src={src}
            alt={alt}
            style={width && height ? { width, height } : undefined}
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (naturalWidth > 0 && naturalHeight > 0)
                setNatural({ width: naturalWidth, height: naturalHeight });
            }}
          />
        </div>
      </DialogPanel>
    </Dialog>
  );
}
