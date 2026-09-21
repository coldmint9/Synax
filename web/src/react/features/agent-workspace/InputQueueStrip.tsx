import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { GripVertical, ListStart, Paperclip, Pencil, X } from "lucide-react";
import type { QueuedInput } from "../../../lib/api/agentRuntime";
import type { RuntimeContentPart } from "../../../lib/api/runtimeMedia";
import { runtimeMedia } from "../../../lib/api/runtimeMedia";
import { useLocale } from "../../../hooks/useLocale";

interface Props {
  items: QueuedInput[];
  onRemove: (itemId: string) => void | Promise<void>;
  onForce: (itemId: string) => void | Promise<void>;
  onReorder?: (itemId: string, toIndex: number) => Promise<void>;
  onEdit?: (item: QueuedInput) => Promise<void>;
  editDisabledReason?: string;
}

function previewMessage(message: string, max = 56): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

const MAX_VISIBLE_THUMBS = 3;

function QueueMediaThumb({ assetId }: { assetId: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void runtimeMedia
      .blob(assetId, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);
  if (!url)
    return (
      <span className="queue-media-thumb inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted/70 text-muted-foreground">
        <Paperclip size={10} aria-hidden />
      </span>
    );
  return (
    <img
      src={url}
      alt=""
      className="queue-media-thumb size-5 shrink-0 rounded object-cover ring-1 ring-border/50"
    />
  );
}

function QueueMediaIndicators({ parts }: { parts?: RuntimeContentPart[] }) {
  const media = parts?.filter((p) => p.type !== "text");
  if (!media?.length) return null;
  const images = media.filter((p) => p.type === "image");
  const files = media.length - images.length;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {images.slice(0, MAX_VISIBLE_THUMBS).map((p, i) => (
        <QueueMediaThumb key={`${p.assetId}-${i}`} assetId={p.assetId} />
      ))}
      {images.length > MAX_VISIBLE_THUMBS && (
        <span className="text-[10px] tabular-nums text-muted-foreground">
          +{images.length - MAX_VISIBLE_THUMBS}
        </span>
      )}
      {files > 0 && (
        <span className="inline-flex h-5 items-center gap-0.5 rounded-full bg-muted/70 px-1.5 text-[10px] tabular-nums text-muted-foreground">
          <Paperclip size={10} aria-hidden />
          {files}
        </span>
      )}
    </span>
  );
}

export function InputQueueStrip({
  items,
  onRemove,
  onForce,
  onReorder,
  onEdit,
  editDisabledReason,
}: Props) {
  const { t, locale } = useLocale();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{
    id: string;
    position: "above" | "below";
  } | null>(null);
  const busy = useRef(false);
  const runAction = async (action: () => void | Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setMoving(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busy.current = false;
      setMoving(false);
    }
  };
  const canReorder = Boolean(onReorder) && items.length > 1;

  const clearDragState = () => {
    setDraggingId(null);
    setDropHint(null);
  };

  const handleItemDragStart =
    (itemId: string) => (event: DragEvent<HTMLButtonElement>) => {
      event.dataTransfer?.setData("text/plain", itemId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      setDraggingId(itemId);
    };

  const handleItemDragOver =
    (itemId: string) => (event: DragEvent<HTMLLIElement>) => {
      if (!draggingId || draggingId === itemId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const rect = event.currentTarget.getBoundingClientRect();
      const position =
        event.clientY > rect.top + rect.height / 2 ? "below" : "above";
      setDropHint((prev) =>
        prev && prev.id === itemId && prev.position === position
          ? prev
          : { id: itemId, position },
      );
    };

  const handleItemDrop =
    (itemId: string, index: number) => (event: DragEvent<HTMLLIElement>) => {
      event.preventDefault();
      const sourceId = draggingId;
      clearDragState();
      if (!sourceId || !onReorder || sourceId === itemId) return;
      const from = items.findIndex((it) => it.id === sourceId);
      if (from === -1) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const below = event.clientY > rect.top + rect.height / 2;
      // The pointer identifies a gap in the original list. The API accepts
      // the final index after removing the source item, not that gap index.
      const gap = below ? index + 1 : index;
      const to = Math.max(
        0,
        Math.min(items.length - 1, gap > from ? gap - 1 : gap),
      );
      if (to === from) return;
      void runAction(() => onReorder(sourceId, to));
    };

  const handleItemKeyDown =
    (itemId: string, index: number) =>
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!onReorder || moving) return;
      if (event.key === "ArrowUp" && index > 0) {
        event.preventDefault();
        void runAction(() => onReorder(itemId, index - 1));
      } else if (event.key === "ArrowDown" && index < items.length - 1) {
        event.preventDefault();
        void runAction(() => onReorder(itemId, index + 1));
      }
    };

  if (items.length === 0) return null;

  return (
    <div className="input-queue-strip pointer-events-auto mb-1.5 w-full min-w-0">
      <div className="input-queue-strip-header mb-1 flex items-center justify-between px-1 text-[10px] text-muted-foreground/70">
        <span>{t("inputQueueTitle", { count: items.length })}</span>
      </div>
      <ul
        className="input-queue-strip-list flex max-h-32 flex-col gap-1 overflow-y-auto overscroll-contain"
        onDragOver={(e) => {
          if (draggingId) e.preventDefault();
        }}
        onDrop={(e) => e.preventDefault()}
      >
        {items.map((item, index) => (
          <li
            key={item.id}
            className={`input-queue-strip-item relative flex shrink-0 items-center gap-1.5 rounded-full border border-border/50 bg-surface/80 px-2.5 py-1 text-[11px] text-foreground/85 backdrop-blur-sm transition-opacity${
              draggingId === item.id ? " opacity-40" : ""
            }`}
            onDragOver={canReorder ? handleItemDragOver(item.id) : undefined}
            onDrop={canReorder ? handleItemDrop(item.id, index) : undefined}
          >
            {dropHint?.id === item.id && (
              <span
                aria-hidden
                className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary/80 ${
                  dropHint.position === "above" ? "-top-1.5" : "-bottom-1.5"
                }`}
              />
            )}
            <span className="min-w-0 flex-1 truncate" title={item.message}>
              {previewMessage(item.message)}
            </span>
            <QueueMediaIndicators parts={item.contentParts} />
            {canReorder && (
              <button
                type="button"
                draggable={!moving}
                onDragStart={handleItemDragStart(item.id)}
                onDragEnd={clearDragState}
                onKeyDown={handleItemKeyDown(item.id, index)}
                disabled={moving}
                aria-label={
                  locale === "zh"
                    ? `拖动调整顺序,当前第 ${index + 1} 项`
                    : `Drag to reorder, item ${index + 1}`
                }
                title={
                  locale === "zh"
                    ? "拖动调整顺序(聚焦后可用 ↑/↓)"
                    : "Drag to reorder (focus and use ↑/↓)"
                }
                className="input-queue-strip-btn inline-flex size-6 shrink-0 cursor-grab items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-primary active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-30"
              >
                <GripVertical size={12} aria-hidden />
              </button>
            )}
            <button
              type="button"
              disabled={moving}
              aria-label={t("inputQueueForce")}
              title={t("inputQueueForce")}
              className="input-queue-strip-btn inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
              onClick={() => void runAction(() => onForce(item.id))}
            >
              <ListStart size={12} aria-hidden />
            </button>
            {onEdit && (
              <button
                type="button"
                disabled={moving || Boolean(editDisabledReason)}
                aria-label={`${locale === "zh" ? "编辑队列消息" : "Edit queued message"} ${index + 1}`}
                title={
                  editDisabledReason ||
                  (locale === "zh"
                    ? "移出队列并编辑"
                    : "Remove from queue and edit")
                }
                className="input-queue-strip-btn inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => void runAction(() => onEdit(item))}
              >
                <Pencil size={12} aria-hidden />
              </button>
            )}
            <button
              type="button"
              aria-label={t("inputQueueRemove")}
              disabled={moving}
              className="input-queue-strip-btn inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              onClick={() => void runAction(() => onRemove(item.id))}
            >
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="px-2 py-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
