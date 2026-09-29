import { useEffect, useRef, useState } from "react";
import { Clipboard, Paperclip, X, RotateCcw } from "lucide-react";
import type { MediaDraft } from "./useMediaDraft";
import { MediaParts } from "./MediaParts";
export function MediaAttachButton({
  media,
  disabled,
}: {
  media: MediaDraft;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          media.add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled}
        aria-label="添加附件 / Attach files"
        title="图片、音频、视频、PDF或文件 / Attach files"
        className="agent-dock-composer-chip inline-flex size-8 items-center justify-center rounded-full disabled:opacity-50"
        onClick={() => ref.current?.click()}
      >
        <Paperclip size={15} />
      </button>
    </>
  );
}
export function MediaDraftPreview({ media }: { media: MediaDraft }) {
  const textItems = media.items.filter((item) => item.text !== undefined);
  return (
    <div aria-live="polite" className="max-h-64 w-full overflow-y-auto text-xs">
      {media.error && (
        <p role="alert" className="text-danger">
          {media.error}
        </p>
      )}
      {media.items
        .filter((item) => item.error && item.text === undefined)
        .map((item) => (
          <div
            key={item.id}
            className="my-1 flex items-center gap-2 rounded-lg bg-surface/60 px-2 py-1"
          >
            <span className="min-w-0 flex-1 truncate" title={item.file.name}>
              {item.file.name}
            </span>
            <span className="text-danger">{item.error}</span>
            <button
              type="button"
              aria-label={`重试 ${item.file.name}`}
              onClick={() => media.retry(item.id)}
            >
              <RotateCcw size={12} />
            </button>
            <button
              type="button"
              aria-label={`移除 ${item.file.name}`}
              onClick={() => media.remove(item.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      <MediaParts
        parts={media.parts}
        onRemove={(assetId) => {
          const item = media.items.find((entry) => entry.asset?.id === assetId);
          if (item) media.remove(item.id);
        }}
      />
      {textItems.map((item) => (
        <TextDraftAttachment
          key={item.id}
          filename={item.file.name}
          text={item.text ?? ""}
          onRemove={() => media.remove(item.id)}
        />
      ))}
    </div>
  );
}

function TextDraftAttachment({
  filename,
  text,
  onRemove,
}: {
  filename: string;
  text: string;
  onRemove: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (opened && dialogRef.current && !dialogRef.current.open)
      dialogRef.current.showModal();
  }, [opened]);
  return (
    <div className="relative my-1 max-w-full rounded-xl border border-border/50 bg-surface/60 p-2 text-xs">
      <button
        type="button"
        className="max-w-[calc(100%-2rem)] truncate text-left text-primary hover:underline"
        title="预览文本摘要 / Preview text summary"
        onClick={() => setOpened(true)}
      >
        <Paperclip className="mr-1 inline-block" size={12} />
        {filename}
        <span className="ml-2 text-muted-foreground">
          {text.length.toLocaleString()} 字符 / chars
        </span>
      </button>
      <button
        type="button"
        aria-label={`移除 ${filename}`}
        title="移除附件 / Remove attachment"
        className="absolute right-1.5 top-1.5 inline-flex size-6 items-center justify-center rounded-full border border-border/70 bg-background/90 text-muted-foreground"
        onClick={onRemove}
      >
        <X size={13} />
      </button>
      {opened && (
        <dialog
          ref={dialogRef}
          onClose={() => setOpened(false)}
          aria-modal="true"
          aria-label={filename}
          className="media-preview-dialog"
        >
          <div className="flex max-h-[80vh] w-[min(90vw,900px)] flex-col gap-3 rounded-xl bg-background p-4 text-foreground">
            <div className="flex items-center justify-between gap-3">
              <h2 className="truncate text-sm font-medium">{filename}</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-surface"
                  onClick={() => void navigator.clipboard.writeText(text)}
                >
                  <Clipboard size={13} />
                  复制
                </button>
                <button
                  type="button"
                  aria-label="关闭 / Close"
                  className="text-foreground"
                  onClick={() => setOpened(false)}
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface/70 p-3 text-left text-xs leading-5">
              {text}
            </pre>
          </div>
        </dialog>
      )}
    </div>
  );
}
