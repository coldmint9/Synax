import { useEffect, useRef, useState } from "react";
import { Clipboard, Download, LoaderCircle, Paperclip, X } from "lucide-react";
import {
  runtimeMedia,
  type RuntimeAsset,
  type RuntimeContentPart,
} from "../../adapters/transport/runtimeMedia";
function MediaAsset({
  id,
  onRemove,
}: {
  id: string;
  onRemove?: (id: string) => void;
}) {
  const [asset, setAsset] = useState<RuntimeAsset>();
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [opened, setOpened] = useState(false);
  const [textContent, setTextContent] = useState<string>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (opened && dialogRef.current && !dialogRef.current.open)
      dialogRef.current.showModal();
  }, [opened]);
  useEffect(() => {
    const controller = new AbortController();
    setAsset(undefined);
    setUrl(undefined);
    setError("");
    setTextContent(undefined);
    let objectUrl: string | undefined;
    void runtimeMedia
      .metadata(id)
      .then(async ({ asset }) => {
        if (controller.signal.aborted) return;
        setAsset(asset);
        const blob = await runtimeMedia.blob(id, controller.signal);
        if (controller.signal.aborted) return;
        const text = asset.mediaType === "text/plain" ? await blob.text() : undefined;
        if (controller.signal.aborted) return;
        setTextContent(text);
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, retry]);
  if (error)
    return (
      <div role="alert" className="flex items-center gap-3 rounded-xl border border-danger/20 bg-surface/60 p-3 text-xs">
        <span className="text-danger">{error}</span>
        <button type="button" className="shrink-0 rounded-md px-2 py-1 text-foreground hover:bg-background focus-visible:outline focus-visible:outline-2" onClick={() => setRetry((value) => value + 1)}>重试</button>
        {onRemove && <button type="button" aria-label="移除附件" onClick={() => onRemove(id)}><X size={14} /></button>}
      </div>
    );
  if (!asset || !url)
    return (
      <div role="status" aria-live="polite" aria-busy="true" data-transcript-pending="true" className="relative flex min-h-24 w-56 max-w-full items-center gap-3 rounded-xl border border-border/50 bg-surface/60 p-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/5 text-muted-foreground">
          <LoaderCircle size={20} aria-hidden="true" className="motion-safe:animate-spin" />
        </div>
        <div className="min-w-0 space-y-1.5 text-xs">
          <p className="truncate font-medium text-foreground">{asset?.filename ?? "正在加载附件"}</p>
          <p className="text-muted-foreground">{asset ? "正在读取内容…" : "正在获取附件信息…"}</p>
        </div>
        {onRemove && <button type="button" aria-label="移除附件" className="absolute right-1.5 top-1.5 rounded-full p-1 text-muted-foreground hover:text-foreground" onClick={() => onRemove(id)}><X size={13} /></button>}
      </div>
    );
  const image = /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(asset.mediaType);
  const text = asset.mediaType === "text/plain";
  const copyText = async () => {
    if (textContent !== undefined) await navigator.clipboard.writeText(textContent);
  };
  return (
    <div data-transcript-pending={!url ? "true" : undefined} className="relative max-w-full rounded-xl border border-border/50 bg-surface/60 p-2 text-xs">
      {onRemove && (
        <button
          type="button"
          aria-label={`移除 ${asset.filename}`}
          title="移除附件 / Remove attachment"
          className="absolute right-1.5 top-1.5 z-10 inline-flex size-6 items-center justify-center rounded-full border border-border/70 bg-background/90 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background hover:text-foreground"
          onClick={() => onRemove(id)}
        >
          <X size={13} />
        </button>
      )}
      {image && url && (
        <button
          type="button"
          onClick={() => setOpened(true)}
          aria-label={`查看 ${asset.filename}`}
        >
          <img
            src={url}
            alt={asset.filename}
            className="max-h-32 max-w-56 rounded-lg object-contain"
          />
        </button>
      )}
      {asset.mediaType.startsWith("audio/") && url && (
        <audio
          controls
          preload="metadata"
          src={url}
          aria-label={asset.filename}
          className="max-w-full"
        />
      )}
      {asset.mediaType.startsWith("video/") && url && (
        <video
          controls
          preload="metadata"
          src={url}
          aria-label={asset.filename}
          className="max-h-48 max-w-full rounded-lg"
        />
      )}
      {!image && (
        <div className="mt-1 flex items-center gap-2">
          <Paperclip size={12} />
          {text && url ? (
            <button
              type="button"
              className="max-w-48 truncate text-left text-primary hover:underline"
              title="预览文本摘要 / Preview text summary"
              onClick={() => setOpened(true)}
            >
              {asset.filename}
            </button>
          ) : (
            <span className="max-w-48 truncate" title={asset.filename}>
              {asset.filename}
            </span>
          )}
          <span className="text-muted-foreground">
            {asset.size < 1024
              ? `${asset.size} B`
              : `${(asset.size / 1024).toFixed(0)} KB`}
          </span>
          {url && (
            <a
              href={url}
              download={asset.filename}
              aria-label={`下载 ${asset.filename}`}
              className="text-primary"
            >
              <Download size={14} />
            </a>
          )}
          {url && asset.mediaType === "application/pdf" && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-primary"
            >
              查看 / View
            </a>
          )}
        </div>
      )}
      {opened && url && (
        <dialog
          ref={dialogRef}
          onClose={() => setOpened(false)}
          role="dialog"
          aria-modal="true"
          aria-label={asset.filename}
          className="media-preview-dialog"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpened(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpened(false);
          }}
        >
          <button
            autoFocus
            type="button"
            aria-label="关闭 / Close"
            className="absolute right-5 top-5 text-white"
            onClick={() => setOpened(false)}
          >
            <X />
          </button>
          {text ? (
            <div className="flex max-h-[80vh] w-[min(90vw,900px)] flex-col gap-3 rounded-xl bg-background p-4 text-foreground">
              <div className="flex items-center justify-between gap-3">
                <h2 className="truncate text-sm font-medium">{asset.filename}</h2>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-surface"
                  onClick={() => void copyText()}
                  disabled={textContent === undefined}
                >
                  <Clipboard size={13} />
                  复制
                </button>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface/70 p-3 text-left text-xs leading-5">
                {textContent ?? "加载文本… / Loading text…"}
              </pre>
            </div>
          ) : (
            <img
              src={url}
              alt={asset.filename}
              className="max-h-full max-w-full object-contain"
            />
          )}
        </dialog>
      )}
    </div>
  );
}
export function MediaParts({
  parts,
  onRemove,
}: {
  parts?: RuntimeContentPart[];
  onRemove?: (id: string) => void;
}) {
  const media = parts?.filter((p) => p.type !== "text");
  if (!media?.length) return null;
  return (
    <div className="my-1 flex max-w-full flex-wrap gap-2">
      {media.map((p, i) => (
        <MediaAsset
          key={`${p.assetId}-${i}`}
          id={p.assetId}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
