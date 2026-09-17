import { useEffect, useRef, useState } from "react";
import { Download, Paperclip, X } from "lucide-react";
import {
  runtimeMedia,
  type RuntimeAsset,
  type RuntimeContentPart,
} from "../../../lib/api/runtimeMedia";
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
  const [opened, setOpened] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (opened && dialogRef.current && !dialogRef.current.open)
      dialogRef.current.showModal();
  }, [opened]);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void runtimeMedia
      .metadata(id)
      .then(async ({ asset }) => {
        if (controller.signal.aborted) return;
        setAsset(asset);
        const blob = await runtimeMedia.blob(id, controller.signal);
        if (controller.signal.aborted) return;
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
  }, [id]);
  if (error)
    return (
      <span role="alert" className="text-xs text-danger">
        {error} ({id})
      </span>
    );
  if (!asset)
    return (
      <span className="text-xs text-muted-foreground">
        加载附件… / Loading attachment…
      </span>
    );
  const image = /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(asset.mediaType);
  return (
    <div className="relative max-w-full rounded-xl border border-border/50 bg-surface/60 p-2 text-xs">
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
      <div className="mt-1 flex items-center gap-2">
        <Paperclip size={12} />
        <span className="max-w-48 truncate" title={asset.filename}>
          {asset.filename}
        </span>
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
      {opened && url && (
        <dialog
          ref={dialogRef}
          onClose={() => setOpened(false)}
          role="dialog"
          aria-modal="true"
          aria-label={asset.filename}
          className="fixed inset-0 m-auto h-[90vh] w-[95vw] max-w-none items-center justify-center border-0 bg-black/80 p-8 text-white backdrop:bg-black/80"
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
          <img
            src={url}
            alt={asset.filename}
            className="max-h-full max-w-full object-contain"
          />
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
